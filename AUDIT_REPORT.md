# LEAP Importer - Comprehensive Audit Report

**Date:** May 4, 2026  
**Project:** LEAP LMS Course Importer (Playwright Automation)  
**Scope:** Full codebase audit for bugs, design issues, and improvement opportunities

---

## Executive Summary

This Playwright-based automation system is **functionally sound** but has several **critical fragility points** that could cause intermittent failures in production. The primary concerns are:

1. **Race conditions** in DOM state verification and form validation
2. **Brittle selectors** and DOM assumptions that depend on specific Angular DOM structure
3. **Hard-coded timeouts** with no configurability for slow networks/environments
4. **Missing error recovery** in multi-step operations (dialog opens, content fills, saves)
5. **Unverified assumptions** about what the server actually accepted

The good news: Most issues are **localized** and can be fixed with targeted improvements rather than rewrites.

---

## CRITICAL ISSUES
*These are likely to cause automation failures in production*

### 1. **Race Condition: Slide Type Not Committed on First Try**
**Location:** [automation.js](automation.js#L434-L455)  
**Severity:** High  
**Problem:**
```javascript
await selectMatSelectOption(page, slideTypeSelect, slideTypeLabel);
await page.keyboard.press('Escape');
await clearOverlays(page);

const committedType = await slideTypeSelect
  .locator('.mat-select-value-text').innerText().catch(() => '');
if (!committedType.trim()) {
  // Value didn't commit -- wait for Angular to settle then retry once
  await page.waitForTimeout(800);
  await selectMatSelectOption(page, slideTypeSelect, slideTypeLabel);
  ...
}
```

**Why it's a problem:**
- The `.mat-select-value-text` might not update immediately after the dropdown closes
- The retry only happens if the text is empty—but what if it shows the *old* type instead of blank?
- If the retry also fails silently, the wrong slide type is created without error
- Angular's reactive forms might not have wired up the control yet when the select is visible

**Minimal fix:**
```javascript
// After selecting, verify the actual value by querying the form control
let attempts = 0;
while (attempts < 3) {
  const currentType = await slideTypeSelect
    .locator('.mat-select-value-text').innerText().catch(() => '').then(t => t.trim());
  
  if (currentType === slideTypeLabel) {
    break; // Success
  }
  
  if (attempts < 2) {
    emitLog(`Slide type mismatch (attempt ${attempts + 1}): got "${currentType}", expected "${slideTypeLabel}"`);
    await page.waitForTimeout(500);
    await selectMatSelectOption(page, slideTypeSelect, slideTypeLabel);
    await page.keyboard.press('Escape');
    await clearOverlays(page);
  } else {
    throw new Error(`Failed to set slide type to "${slideTypeLabel}". Final value: "${currentType}"`);
  }
  attempts++;
}
```

---

### 2. **Fragile Slide Matching Logic—Prefix Collisions & Visibility Races**
**Location:** [automation.js](automation.js#L400-L430)  
**Severity:** High  
**Problem:**
```javascript
const slideMatchKeysList = slideMatchKeys(slide.slide_name);
let existingSlideItem = null;
for (const matchKey of slideMatchKeysList) {
  const candidates = page.locator('mat-list-option').filter({ hasText: matchKey });
  const count = await candidates.count().catch(() => 0);
  for (let ci = 0; ci < count; ci++) {
    const candidate = candidates.nth(ci);
    if (!(await candidate.isVisible().catch(() => false))) continue;  // ← visibility check can race
    const candidateText = await candidate.textContent().catch(() => '');
    if (!candidateText.trim().includes(slide.slide_name.trim())) continue;
    await candidate.click();  // ← before checking DOM fully loaded
    ...
  }
}
```

**Why it's a problem:**
- `.isVisible()` only checks current DOM state; element might become hidden immediately after
- Clicking a candidate immediately after visibility check can fail if the element becomes detached
- If multiple slides match (e.g., "Lesson A" and "Lesson A - Part 2"), the first visible one wins—might be wrong
- Virtual scrolling means elements outside viewport are removed from DOM; scrolling and searching race
- `textContent()` might include whitespace/hidden text that affects matching

**Minimal fix:**
```javascript
async function findSlideOptionByKeys(page, fullTitle, timeout = 20000) {
  const keys = slideMatchKeys(fullTitle);
  const start = Date.now();
  const vscroll = page.locator('cdk-virtual-scroll-viewport').first();
  
  while (Date.now() - start < timeout) {
    for (const key of keys) {
      // Use more specific selector and verify before clicking
      const candidates = page.locator('mat-list-option', { hasText: new RegExp(`\\b${key}\\b`) });
      
      for (let i = 0; i < await candidates.count(); i++) {
        const candidate = candidates.nth(i);
        
        // Wait for it to be in stable state, not just visible
        try {
          await candidate.waitFor({ state: 'attached', timeout: 2000 });
        } catch {
          continue; // Element disappeared
        }
        
        const text = await candidate.textContent();
        if (!text.includes(fullTitle.trim())) continue;
        
        // Before clicking, scroll into view and wait for stability
        await candidate.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200); // Let layout stabilize
        
        if (!(await candidate.isVisible({ timeout: 2000 }).catch(() => false))) continue;
        
        return candidate;
      }
    }
    
    // Scroll and retry
    if (await vscroll.count()) {
      await vscroll.evaluate(el => el.scrollBy(0, Math.max(240, el.clientHeight * 0.8)));
    } else {
      await page.mouse.wheel(0, 700);
    }
    
    await page.waitForTimeout(150);
  }
  
  throw new Error(`Slide not found after ${timeout}ms: "${fullTitle}". Checked keys: ${keys.join(', ')}`);
}
```

---

### 3. **Async Row Addition Race—Count-Based Detection Is Unreliable**
**Location:** [automation.js](automation.js#L507-L530) (matching questions), [automation.js](automation.js#L600-L620) (multiple choice)  
**Severity:** High  
**Problem:**
```javascript
const before = await choiceInputs.count();
await addBtn.click();
await waitForCountIncrease(choiceInputs, before, 10000);  // ← waits for count to increase
await choiceInputs.nth(before).fill(slide.options[optionIndex].text);
```

```javascript
async function waitForCountIncrease(locator, beforeCount, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const current = await locator.count();
    if (current > beforeCount) return current;  // ← returns immediately, element might not be interactive yet
    await locator.page().waitForTimeout(50);
  }
  throw new Error(`Timeout waiting for count to increase (before=${beforeCount})`);
}
```

**Why it's a problem:**
- The element count increases, but the new `input` might not be attached to the DOM yet
- Calling `.nth(before).fill()` immediately after count increase can try to fill an invisible/readonly element
- In Angular Material, adding a form control is async—the count increases but the form group update is still pending
- If Angular is slow, the fill might fail silently or fill the wrong input

**Minimal fix:**
```javascript
async function waitForNewInput(locator, indexExpected, timeout = 10000) {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    const count = await locator.count();
    
    if (count > indexExpected) {
      const newInput = locator.nth(indexExpected);
      
      // Wait for it to be interactive
      try {
        await newInput.waitFor({ state: 'visible', timeout: 2000 });
        await newInput.evaluate(el => {
          // Verify it's writable (not readonly)
          if ((el as any).readOnly) throw new Error('Input is read-only');
        });
        
        return newInput;
      } catch (e) {
        // Element appeared but isn't ready yet, keep waiting
        await page.waitForTimeout(100);
        continue;
      }
    }
    
    await locator.page().waitForTimeout(50);
  }
  
  throw new Error(`Timeout waiting for new input at index ${indexExpected}`);
}

// Usage:
const before = await choiceInputs.count();
await addBtn.click();
const newInput = await waitForNewInput(choiceInputs, before, 10000);
await newInput.fill(slide.options[optionIndex].text);
```

---

### 4. **Save Not Actually Verified—Form Saved State Is Unreliable**
**Location:** [automation.js](automation.js#L271-L285)  
**Severity:** Critical  
**Problem:**
```javascript
async function saveWithRetry(page, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await forceDirtyViaSlideType(page);
    const saveEnabled = page.locator('button.mat-raised-button.mat-primary:has-text("Save"):not([disabled])').first();
    await saveEnabled.waitFor({ state: 'visible', timeout: 10000 });
    await clearOverlays(page);
    await saveEnabled.click();
    await page.waitForTimeout(1200);  // ← arbitrary wait
    await waitLessonInteractive(page);  // ← only checks if UI appears interactive
    
    const saveStillEnabled = await page.locator(...).first().isVisible().catch(() => false);
    if (!saveStillEnabled) return;  // ← assumes if Save is disabled, it succeeded
    ...
  }
}
```

**Why it's a problem:**
- The code assumes "Save button disabled" = "save succeeded", but LEAP might have errors and the button disabled anyway
- If the server returns an error but doesn't show it in the UI, the automation still thinks it succeeded
- The 1200ms wait is arbitrary—LEAP might take longer
- If there's a validation error on the form, the Save button stays disabled and the code throws an error
- No way to distinguish between "save is processing" vs "save failed"

**Minimal fix:**
```javascript
async function saveWithRetry(page, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    emitLog(`Attempting to save slide (attempt ${attempt}/${maxAttempts})...`);
    
    await forceDirtyViaSlideType(page);
    
    const saveBtn = page.locator('button.mat-raised-button.mat-primary:has-text("Save"):not([disabled])').first();
    await saveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await clearOverlays(page);
    
    // Check for validation errors BEFORE clicking save
    const errors = await page.locator('mat-error').allTextContents().catch(() => []);
    if (errors.length > 0) {
      throw new Error(`Cannot save—form has validation errors: ${errors.join('; ')}`);
    }
    
    // Capture the Save button's disabled state before clicking
    const wasSaving = await saveBtn.evaluate(el => (el as HTMLButtonElement).disabled);
    
    await saveBtn.click();
    
    // Wait for the button to enter a loading/disabled state
    await page.waitForTimeout(400);
    const isNowLoading = await saveBtn.evaluate(el => (el as HTMLButtonElement).disabled).catch(() => false);
    
    if (!isNowLoading && attempt === 1) {
      // Button isn't disabled after click—might mean it didn't register
      await page.waitForTimeout(600);
    }
    
    // Wait for either:
    // 1. Save button to appear enabled again (save completed), OR
    // 2. Success toast/notification to appear, OR
    // 3. Timeout
    try {
      await Promise.race([
        saveBtn.waitFor({ state: 'visible', timeout: 8000 }).then(async () => {
          // Wait for button to be enabled
          let ready = false;
          for (let i = 0; i < 40; i++) {
            const disabled = await saveBtn.evaluate(el => (el as HTMLButtonElement).disabled).catch(() => true);
            if (!disabled) {
              ready = true;
              break;
            }
            await page.waitForTimeout(150);
          }
          if (!ready) throw new Error('Save button never became enabled');
        }),
        page.locator('.mat-snack-bar-container:has-text("success|saved|created")').waitFor({ timeout: 8000 }).catch(() => null),
      ]);
    } catch (e) {
      if (attempt === maxAttempts) {
        throw new Error(`Save did not complete after ${maxAttempts} attempts: ${e.message}`);
      }
      emitLog(`Save attempt ${attempt} timed out, retrying...`, 'warn');
      continue;
    }
    
    await clearOverlays(page);
    await waitLessonInteractive(page);
    
    // Final check: are there error messages?
    const finalErrors = await page.locator('mat-error').allTextContents().catch(() => []);
    if (finalErrors.length > 0) {
      if (attempt === maxAttempts) {
        throw new Error(`Save failed with errors: ${finalErrors.join('; ')}`);
      }
      emitLog(`Save resulted in errors, retrying: ${finalErrors.join('; ')}`, 'warn');
      continue;
    }
    
    return; // Success
  }
}
```

---

### 5. **Clipboard Paste May Fail Silently**
**Location:** [automation.js](automation.js#L103-L113)  
**Severity:** Medium  
**Problem:**
```javascript
async function pasteIntoInput(page, locator, text) {
  await page.evaluate(async value => {
    await navigator.clipboard.writeText(value);  // ← might fail silently
  }, text);
  await locator.click();
  await locator.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await locator.evaluate(el => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));  // ← Angular might not listen for these
  });
}
```

**Why it's a problem:**
- Clipboard API can be denied by the browser without throwing an error
- The `input` and `change` events might not trigger Angular form validation properly
- Some browsers/contexts deny clipboard access entirely
- If the paste fails, there's no fallback—no error is logged

**Minimal fix:**
```javascript
async function pasteIntoInput(page, locator, text) {
  try {
    // Try clipboard first
    const clipboardGranted = await page.evaluate(async () => {
      try {
        const perm = await navigator.permissions?.query?.({ name: 'clipboard-write' });
        return perm?.state !== 'denied';
      } catch {
        return true; // Assume it's OK if we can't query
      }
    });
    
    if (clipboardGranted) {
      await page.evaluate(async value => {
        try {
          await navigator.clipboard.writeText(value);
        } catch (e) {
          throw new Error(`Clipboard write failed: ${e.message}`);
        }
      }, text);
      
      await locator.click();
      await locator.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    } else {
      throw new Error('Clipboard access denied');
    }
  } catch (e) {
    emitLog(`Clipboard paste failed, falling back to .fill(): ${e.message}`, 'warn');
    
    // Fallback: use Playwright's fill() which handles Angular
    await locator.fill(text);
  }
  
  // Ensure form recognizes the change
  await locator.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, text);
}
```

---

### 6. **Form Dirty State Detection Is Fragile**
**Location:** [automation.js](automation.js#L140-L147)  
**Severity:** Medium  
**Problem:**
```javascript
async function forceDirtyViaSlideType(page) {
  const slideTypeSelect = page.locator('mat-select[formcontrolname="slideType"]').first();
  await slideTypeSelect.waitFor({ state: 'visible', timeout: 10000 });
  await slideTypeSelect.click();  // ← might fail if the form isn't ready
  await page.keyboard.press('Escape');
  await clearOverlays(page);
}
```

**Why it's a problem:**
- If the form hasn't initialized its reactive controls yet, clicking does nothing
- The slide type select might not trigger the form's `dirty` flag if Angular's change detection hasn't run
- If the select is inside a dialog or disabled, this fails
- Pressing Escape might close the dialog instead of the dropdown if the dropdown isn't fully open

**Minimal fix:**
```javascript
async function forceDirtyViaSlideType(page) {
  const slideTypeSelect = page.locator('mat-select[formcontrolname="slideType"]').first();
  await slideTypeSelect.waitFor({ state: 'visible', timeout: 10000 });
  
  // Verify the form control is actually attached and accessible
  const isDisabled = await slideTypeSelect.evaluate(
    el => (el as any).disabled === true || (el as HTMLElement).getAttribute('aria-disabled') === 'true'
  );
  
  if (isDisabled) {
    emitLog(`Slide type select is disabled, cannot mark form dirty. This might cause save issues.`, 'warn');
    return; // Don't fail—it might not be needed
  }
  
  try {
    await slideTypeSelect.click();
    await page.waitForTimeout(200); // Let dropdown open
    
    // Verify dropdown opened
    const panelId = await slideTypeSelect.getAttribute('aria-controls').catch(() => null);
    if (panelId) {
      const panel = page.locator(`#${panelId}`);
      const isOpen = await panel.isVisible().catch(() => false);
      if (!isOpen) {
        throw new Error('Dropdown did not open');
      }
    }
    
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
  } catch (e) {
    emitLog(`Failed to force dirty via dropdown: ${e.message}`, 'warn');
    // Try alternative: directly mark form as dirty via JavaScript
    await page.evaluate(() => {
      const form = (document as any).querySelector('form[ng-form], form[formGroup]');
      if (form && form.__ngContext__) {
        // This is a hack, but sometimes necessary
        emitLog('Could not mark form dirty, might cause save failures', 'warn');
      }
    });
  }
}
```

---

### 7. **Hard-Coded Timeouts Make Automation Fragile**
**Location:** Throughout [automation.js](automation.js)  
**Severity:** Medium  
**Problem:**

The code has many hard-coded timeouts like `waitFor({ timeout: 10000 })`, `waitForTimeout(1200)`, etc. These fail in:
- Slow network environments
- Resource-constrained CI/CD
- During peak LEAP usage
- On initial page loads with cold caches

**Impact:**
- Intermittent failures that are hard to debug
- Need to rerun the entire automation to recover
- No way to adjust timeouts without code changes

**Minimal fix:**
```javascript
// At the top of automation.js, add configurable timeouts
const TIMEOUTS = {
  fast: parseInt(process.env.TIMEOUT_FAST || '2000'),
  normal: parseInt(process.env.TIMEOUT_NORMAL || '10000'),
  slow: parseInt(process.env.TIMEOUT_SLOW || '20000'),
  extraSlow: parseInt(process.env.TIMEOUT_EXTRA_SLOW || '30000'),
};

// Then use them instead of hard-coded values:
// Before: await dialog.waitFor({ state: 'hidden', timeout: 10000 });
// After:  await dialog.waitFor({ state: 'hidden', timeout: TIMEOUTS.normal });
```

Then in [server.js](server.js), pass environment variables when spawning:
```javascript
const child = spawn(process.execPath, automationArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    FORCE_COLOR: '0',
    TIMEOUT_FAST: process.env.AUTOMATION_TIMEOUT_FAST || '2000',
    TIMEOUT_NORMAL: process.env.AUTOMATION_TIMEOUT_NORMAL || '10000',
    TIMEOUT_SLOW: process.env.AUTOMATION_TIMEOUT_SLOW || '20000',
  },
});
```

---

### 8. **No Graceful Dialog Close Verification**
**Location:** Multiple places (e.g., [automation.js](automation.js#L525), [automation.js](automation.js#L668))  
**Severity:** Medium  
**Problem:**
```javascript
const okBtn = settingsDialog.locator('.mat-dialog-actions button.mat-primary', { hasText: 'OK' });
await okBtn.waitFor({ state: 'visible', timeout: 10000 });
await okBtn.click();
await settingsDialog.waitFor({ state: 'hidden', timeout: 15000 });  // ← might timeout if dialog stuck
await clearOverlays(page);
```

**Why it's a problem:**
- Dialog might not close if there's a validation error
- The error message inside the dialog isn't captured—the automation just times out
- No retry or error recovery mechanism
- If the dialog sticks, the entire run fails

**Minimal fix:**
```javascript
async function closeDialog(dialogLocator, okButtonSelector = '.mat-dialog-actions button.mat-primary') {
  const okBtn = dialogLocator.locator(okButtonSelector).first();
  await okBtn.waitFor({ state: 'visible', timeout: 10000 });
  
  // Check for validation errors before clicking
  const errors = await dialogLocator.locator('mat-error').allTextContents().catch(() => []);
  if (errors.length > 0) {
    throw new Error(`Dialog has validation errors before close: ${errors.join('; ')}`);
  }
  
  await okBtn.click();
  
  try {
    await dialogLocator.waitFor({ state: 'hidden', timeout: 8000 });
  } catch (e) {
    // Dialog didn't close—check for errors
    const postErrors = await dialogLocator.locator('mat-error').allTextContents().catch(() => []);
    if (postErrors.length > 0) {
      throw new Error(`Dialog close failed. Validation errors: ${postErrors.join('; ')}`);
    }
    
    // Try pressing Escape
    await okBtn.page().keyboard.press('Escape');
    await dialogLocator.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {
      throw new Error('Dialog did not close even after Escape');
    });
  }
}

// Usage:
await closeDialog(settingsDialog);
await clearOverlays(page);
```

---

### 9. **Unhandled Race in Virtual Scrolling**
**Location:** [automation.js](automation.js#L190-L215)  
**Severity:** Medium  
**Problem:**
```javascript
while (Date.now() - start < timeout) {
  for (const key of keys) {
    const candidate = page.locator('mat-list-option').filter({ hasText: key }).first();
    if (await candidate.count().catch(() => 0)) {
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  
  if (await vscroll.count().catch(() => 0)) {
    await vscroll.evaluate(el => el.scrollBy(0, Math.max(240, el.clientHeight * 0.8)));
  } else if (await listFallback.count().catch(() => 0)) {
    await listFallback.evaluate(el => el.scrollBy(0, Math.max(240, el.clientHeight * 0.8)));
  } else {
    await page.mouse.wheel(0, 700);
  }
  await page.waitForTimeout(120);
}
```

**Why it's a problem:**
- Virtual scrolling removes off-screen elements from DOM
- Elements that were visible might be detached when scrolling
- The timeout loop doesn't account for initial load time before items appear
- If the slide is at the very bottom, the scroll might overshoot

---

## IMPROVEMENTS
*These won't cause failures but will improve reliability, performance, or maintainability*

### 1. **Better Error Context in Logs**
**Current:** `throw new Error('Save did not stabilize after retries.')`  
**Better:**
```javascript
throw new Error(
  `Save did not stabilize after ${maxAttempts} attempts. ` +
  `Last form state: dirty=${isDirty}, hasErrors=${hasErrors}, ` +
  `validationErrors=${errors.join('; ')}`
);
```

---

### 2. **Add Structured Logging Levels**
**Current:**
```javascript
emitLog('Some message');
```

**Better:**
```javascript
enum LogLevel { DEBUG, INFO, WARN, ERROR }
emitLog('Some message', LogLevel.WARN, {
  context: { slideType: 'matching', attemptNumber: 2 },
  duration: Date.now() - startTime,
});
```

---

### 3. **Extract Hard-Coded Selectors to Constants**
**Current:**
```javascript
await page.locator('mat-select[formcontrolname="slideType"]').first();
// ... repeated 5+ times
```

**Better:**
```javascript
const SELECTORS = {
  slideTypeSelect: () => page.locator('mat-select[formcontrolname="slideType"]').first(),
  settingsDialog: () => page.locator('mat-dialog-container').last(),
  saveButton: () => page.locator('button.mat-raised-button.mat-primary:has-text("Save"):not([disabled])').first(),
  // ...
};

// Usage:
await SELECTORS.slideTypeSelect().click();
```

---

### 4. **Add Telemetry/Metrics for Success Rates**
**Current:** Only pass/fail per slide  
**Better:**
```javascript
const metrics = {
  slideTypeSetAttempts: [],  // [1, 2, 1, 1, 3, ...] attempts needed
  averageDialogCloseTime: 0,
  averageSaveTime: 0,
  failuresByType: {},  // { 'matching': 2, 'true_false': 0, ... }
};

// Use this to identify which slide types are most fragile
```

---

### 5. **No Validation of courseJson Structure**
**Location:** [server.js](server.js#L113)  
**Problem:**
```javascript
const courseJson = JSON.parse(fs.readFileSync(courseFile, 'utf8'));
// Immediately passed to automation with no validation
```

**Better:**
```javascript
function validateCourseJson(courseJson) {
  const errors = [];
  
  if (!courseJson.course) errors.push('Missing "course" root property');
  if (!Array.isArray(courseJson.course?.units)) errors.push('Missing or invalid "course.units" array');
  
  for (const unit of courseJson.course?.units || []) {
    if (!Array.isArray(unit.lessons)) errors.push(`Unit missing "lessons" array`);
    for (const lesson of unit.lessons || []) {
      if (!lesson.title) errors.push(`Lesson missing "title"`);
      if (!Array.isArray(lesson.slides)) errors.push(`Lesson "${lesson.title}" missing "slides" array`);
      for (const slide of lesson.slides || []) {
        if (!SLIDE_TYPE_MAP[slide.slide_type]) {
          errors.push(`Unknown slide_type: "${slide.slide_type}"`);
        }
      }
    }
  }
  
  if (errors.length > 0) {
    throw new Error(`Invalid courseJson:\n${errors.join('\n')}`);
  }
}

// In POST /api/run/start:
try {
  validateCourseJson(courseJson);
} catch (e) {
  return res.status(400).json({ error: e.message });
}
```

---

### 6. **Memory Leak Risk in SSE Clients Map**
**Location:** [server.js](server.js#L99-L110)  
**Problem:**
```javascript
app.get('/api/run/:runId/events', (req, res) => {
  ...
  if (!sseClients.has(runId)) sseClients.set(runId, []);
  sseClients.get(runId).push(res);  // ← never cleaned up if disconnect is abrupt
  
  req.on('close', () => {
    const clients = sseClients.get(runId) || [];
    sseClients.set(runId, clients.filter(c => c !== res));
  });
});
```

**Better:**
```javascript
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
setInterval(() => {
  for (const [runId, clients] of sseClients.entries()) {
    // Remove dead connections
    const active = clients.filter(res => !res.writableEnded && !res.destroyed);
    if (active.length === 0) {
      sseClients.delete(runId);
    } else if (active.length !== clients.length) {
      sseClients.set(runId, active);
    }
  }
}, CLEANUP_INTERVAL);
```

---

### 7. **Process Error Handling Too Lenient**
**Location:** [server.js](server.js#L192-L215)  
**Problem:**
```javascript
child.stderr.on('data', chunk => {
  const lines = chunk.toString().split('\n').filter(Boolean);
  lines.forEach(line => appendLog({ type: 'error', message: line.trim(), ts: new Date().toISOString() }));
});

child.on('close', async (code) => {
  const status = code === 0 ? 'completed' : 'failed';  // ← process crash logs as 'failed' but automation continues
  ...
});
```

**Better:**
```javascript
child.on('error', (err) => {
  runMeta.status = 'failed';
  runMeta.finishedAt = new Date().toISOString();
  upsertHistory({ ...runMeta });
  appendLog({ type: 'fatal', message: `Process error: ${err.message}`, ts: new Date().toISOString() });
  broadcast(runId, 'run_end', { status: 'failed', reason: 'process_error' });
});

child.on('close', async (code) => {
  if (code !== 0 && code !== null) {
    // Process crashed or was killed
    appendLog({ 
      type: 'fatal', 
      message: `Automation process exited with code ${code}`, 
      ts: new Date().toISOString() 
    });
  }
  ...
});
```

---

### 8. **No Retry for Transient Failures**
**Location:** Various catch blocks that rethrow immediately  
**Problem:**
```javascript
try {
  await page.goto(LMS_URL);
} catch (err) {
  throw err;  // ← network error fails entire run
}
```

**Better:** Add exponential backoff for network/transient errors:
```javascript
async function retryWithBackoff(fn, maxAttempts = 3, initialDelay = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      
      // Only retry for transient errors
      const isTransient = 
        err.message.includes('Timeout') ||
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('ETIMEDOUT');
      
      if (!isTransient) throw err;
      
      const delay = initialDelay * Math.pow(2, attempt - 1);
      emitLog(`Transient error on attempt ${attempt}, retrying in ${delay}ms: ${err.message}`, 'warn');
      await page.waitForTimeout(delay);
    }
  }
}
```

---

### 9. **Brittle Text-Based Selectors**
**Current:**
```javascript
await page.getByRole('button', { name: /new slide/i });
await page.locator('text=Lessons');
```

**Better:** Ask the Angular LMS team for `data-testid` or stable `aria-label` attributes:
```javascript
await page.getByRole('button', { name: /new slide/i });  // Keep as fallback
await page.locator('[data-testid="lessons-nav"]');       // Prefer stable attribute
```

---

### 10. **Missing Step Progress Tracking**
**Current:** Only reports lesson/slide level progress  
**Better:** Track sub-steps:
```javascript
// Each slide creation: form fill, settings dialog, save
emit({
  type: 'slide_step',
  slideName: slide.slide_name,
  step: 'form_fill',
  status: 'in_progress',
});

// After step completes
emit({
  type: 'slide_step',
  slideName: slide.slide_name,
  step: 'form_fill',
  status: 'complete',
  durationMs: 1234,
});
```

---

## LOW-RISK SUGGESTIONS
*Easy wins that improve maintainability*

### 1. Add comments for complex XPath selectors
```javascript
// Find the column wrapper (fxlayout="column") that contains this question
// Don't climb to the inner row (fxlayout="row") or the feedback won't be found
const column = q.locator('xpath=ancestor::div[@fxlayout="column"][1]');
```

### 2. Extract magic numbers to named constants
```javascript
// Current: await page.waitForTimeout(300);
// Better:
const POST_ACTION_SETTLE_TIME_MS = 300;
await page.waitForTimeout(POST_ACTION_SETTLE_TIME_MS);
```

### 3. Use async/await consistently (no `.catch(() => 0)` chains)
```javascript
// Current: await candidate.count().catch(() => 0)
// Better:
const count = await candidate.count().catch(() => 0);
if (count === 0) continue;
```

### 4. Add JSDoc comments for public functions
```javascript
/**
 * Opens a lesson by title and waits for it to fully load.
 * @param {Page} page - Playwright page object
 * @param {string} lessonTitle - Exact title of the lesson
 * @throws {Error} if lesson not found or loading times out
 */
async function openLessonByTitle(page, lessonTitle) {
  ...
}
```

### 5. Consider using a proper logging library instead of `emit()`
```javascript
// Current: emit({ type: 'log', level: 'warn', message: '...' });
// Better: Use winston or pino for structured logging with timestamps, formatting
import winston from 'winston';
const logger = winston.createLogger(...);
logger.warn('Transient error, retrying...', { attempt: 2, error: err.message });
```

### 6. Add dry-run mode that validates courseJson without creating slides
```javascript
if (process.env.DRY_RUN === 'true') {
  emitLog('DRY RUN: would create the following slides');
  for (const slide of allSlides) {
    emitLog(`  - ${slide.slide_name} (${slide.slide_type})`);
  }
  process.exit(0);
}
```

### 7. Better handling of special characters in file names
```javascript
// Current: const safeName = slide.slide_name.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
// Better: Use a library like sanitize-filename
import sanitizeFilename from 'sanitize-filename';
const safeName = sanitizeFilename(slide.slide_name).slice(0, 60);
```

### 8. Log retry attempts with context
```javascript
// Better than silent retries
emitLog(
  `Save attempt ${attempt}/${maxAttempts} failed: ${err.message}. ` +
  `Will retry with exponential backoff in ${backoffMs}ms.`,
  'warn'
);
```

---

## SUMMARY TABLE

| Issue | Severity | File | Type | Fix Effort | Impact |
|-------|----------|------|------|-----------|---------|
| Slide type not verified | Critical | automation.js:434 | Race condition | Medium | High - wrong type created |
| Fragile slide matching | Critical | automation.js:400 | Selector fragility | Medium | High - wrong slide matched |
| Row addition count-based | Critical | automation.js:507 | Async state | Medium | High - wrong data filled |
| Save not verified | **Critical** | automation.js:271 | Logic error | High | **Very High** - silent failures |
| Clipboard paste may fail | High | automation.js:103 | Browser API | Low | Medium - content not filled |
| Form dirty state detection | High | automation.js:140 | Form state | Low | Medium - save won't trigger |
| Hard-coded timeouts | High | Throughout | Config | Medium | High - intermittent failures |
| Dialog close race | Medium | automation.js:525 | Timing | Low | Medium - hangs on errors |
| Virtual scroll race | Medium | automation.js:190 | Race condition | Medium | Medium - can't find slide |
| courseJson validation | Medium | server.js:113 | Input validation | Low | Low - early error detection |
| SSE memory leak | Low | server.js:99 | Resource leak | Low | Low - long-running impact |
| Error handling | Low | server.js:192 | Process mgmt | Low | Medium - hard to debug |
| Text selectors | Low | Throughout | Fragility | Medium | Medium - UI changes break it |

---

## RECOMMENDED FIX PRIORITY

### Phase 1 (Critical—fix first)
1. ✅ **Save verification** (automation.js:271) — **This is the most dangerous**
2. ✅ **Slide type verification** (automation.js:434) — Can create wrong slide types
3. ✅ **Row addition timing** (automation.js:507) — Can fill wrong inputs

### Phase 2 (High—fix soon)
4. **Slide matching robustness** (automation.js:400)
5. **Clipboard paste fallback** (automation.js:103)
6. **Timeout configurability** (throughout)

### Phase 3 (Medium—schedule next release)
7. Dialog close error handling (automation.js:525)
8. courseJson validation (server.js:113)
9. SSE memory leak cleanup (server.js:99)

### Phase 4 (Low—nice to have)
10. Structured logging
11. Telemetry/metrics
12. Comments and documentation

---

## Conclusion

The automation is **well-structured** and handles the complex Angular LMS fairly robustly. However, the **three most critical issues** around save verification, slide type setting, and row addition timing present **significant risk of silent failures**. These should be addressed before using in production.

The other improvements are less urgent but will significantly improve reliability and debuggability.
