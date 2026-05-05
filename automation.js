const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ============================
// Parse CLI args from server.js
// ============================
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

const RUN_ID = getArg('--runId');
const RUN_DIR = getArg('--runDir');
const INPUT_JSON_PATH = getArg('--inputJson');
const RUN_LOG_PATH = getArg('--runLogPath');       // per-run log inside run_outputs/run_xxx/
const PERSISTENT_LOG_PATH = getArg('--persistentLog'); // cross-run log at project root
const START_FROM_LESSON = getArg('--startFrom') || null;
const FORCE_REBUILD = args.includes('--forceRebuild');

const LMS_URL = 'https://control-center.theceshop.com';

// Load the course JSON from the path server wrote
const courseData = JSON.parse(fs.readFileSync(INPUT_JSON_PATH, 'utf8'));

// ============================
// Structured logging to stdout
// Server reads these and broadcasts via SSE
// ============================
function emit(obj) {
  process.stdout.write(JSON.stringify({ ...obj, ts: new Date().toISOString() }) + '\n');
}

function emitLog(message, level = 'info') {
  emit({ type: 'log', level, message });
}

// ============================
// Append-only JSONL slide log (same as original run_log.jsonl)
// ============================
function appendRunLog(entry) {
  const payload = { ...entry, ts: new Date().toISOString() };
  // Write to the per-run log (for this run's archive and artifact viewing)
  fs.appendFileSync(RUN_LOG_PATH, JSON.stringify(payload) + '\n', 'utf8');
  // Also write to the persistent cross-run log (for Normal mode resume across runs)
  if (PERSISTENT_LOG_PATH) {
    fs.appendFileSync(PERSISTENT_LOG_PATH, JSON.stringify(payload) + '\n', 'utf8');
  }
}

function slideKey(lessonTitle, slideName) {
  // Trim both values -- whitespace differences between JSON and log cause
  // silent key mismatches that make Normal mode skip nothing
  return `${(lessonTitle || '').trim()}\x00${(slideName || '').trim()}`;
}

function loadCompletedKeys() {
  const completed = new Set();
  // Read from the persistent cross-run log, not the per-run log.
  // This is what enables Normal mode to skip already-completed slides across runs.
  const logToRead = (PERSISTENT_LOG_PATH && fs.existsSync(PERSISTENT_LOG_PATH))
    ? PERSISTENT_LOG_PATH
    : RUN_LOG_PATH;
  if (!fs.existsSync(logToRead)) return completed;
  const lines = fs.readFileSync(logToRead, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec.status === 'SUCCESS' && rec.lessonTitle && rec.slideName) {
        completed.add(slideKey(rec.lessonTitle, rec.slideName));
      }
    } catch {}
  }
  return completed;
}

// ============================
// JSON → LEAP UI mapping
// ============================
const SLIDE_TYPE_MAP = {
  text_slide: 'Text Area',
  matching: 'Matching',
  true_false: 'True/False',
  multiple_choice: 'Multiple Choice',
  sorting: 'Sort',
};

// ============================
// Helpers (identical to original script)
// ============================
// ============================
// Error translation for plain-language user messages
// ============================
function translateError(err, context = {}) {
  const errMsg = err.message || String(err);
  const { slideName = '', slideType = '', lessonTitle = '' } = context;

  // Pattern 1: Slide settings button timeout
  if (/Timeout.*slide settings/i.test(errMsg) || /slide settings.*visible/i.test(errMsg)) {
    return {
      userMessage: `LEAP didn't show the Slide Settings button for '${slideName}'. The slide type may not have been set correctly.`,
      suggestion: 'Delete the blank slide in LEAP, then run again from this lesson.',
    };
  }

  // Pattern 2: Save button not activating
  if (/Timeout.*Save.*disabled/i.test(errMsg) || /mat-raised-button.*not.*disabled/i.test(errMsg)) {
    return {
      userMessage: `The Save button didn't activate for '${slideName}'.`,
      suggestion: 'Run again from this lesson — the tool will retry automatically.',
    };
  }

  // Pattern 3: Dialog didn't close
  if (/Timeout.*mat-dialog-container.*hidden/i.test(errMsg)) {
    return {
      userMessage: `The slide settings dialog didn't close for '${slideName}'. A required field may be empty.`,
      suggestion: 'Check that all answer options have text in the JSON file for this slide, then run again.',
    };
  }

  // Pattern 4: Login timing issue
  if (/Timeout.*input.*first/i.test(errMsg) || /locator.*fill.*Timeout/i.test(errMsg)) {
    return {
      userMessage: 'The tool logged in but LEAP wasn\'t ready yet.',
      suggestion: 'Run again — the login timing was off.',
    };
  }

  // Pattern 5: Slide not found in list
  if (/Timeout.*mat-list-option/i.test(errMsg) || /Slide not found/i.test(errMsg)) {
    return {
      userMessage: `Could not find '${slideName}' in the lesson slide list.`,
      suggestion: 'Make sure this lesson is open in LEAP and the slide name in your JSON matches exactly what\'s in LEAP.',
    };
  }

  // Pattern 6: Internal script errors
  if (/page is not defined/i.test(errMsg) || /Cannot read properties of undefined/i.test(errMsg)) {
    return {
      userMessage: 'The tool encountered an internal error.',
      suggestion: 'Restart the tool by closing the terminal and running start.bat again.',
    };
  }

  // Pattern 7: Missing module
  if (/MODULE_NOT_FOUND/i.test(errMsg)) {
    return {
      userMessage: 'A required file is missing.',
      suggestion: 'Make sure all files are in the IMPORTER-APP folder and run start.bat again.',
    };
  }

  // Pattern 8: Invalid JSON
  if (/Unexpected token/i.test(errMsg) || /not valid JSON/i.test(errMsg)) {
    return {
      userMessage: 'The course file couldn\'t be read — it may be too large or incorrectly formatted.',
      suggestion: 'Check that your JSON file is valid and under 10MB.',
    };
  }

  // Pattern 9: Feedback-related errors
  if (/feedbackBy|feedback/i.test(errMsg)) {
    return {
      userMessage: `There was a problem setting the feedback options for '${slideName}'.`,
      suggestion: 'Run again from this lesson — this sometimes resolves on retry.',
    };
  }

  // Pattern 10: Catch-all
  return {
    userMessage: `Something went wrong while creating '${slideName}' (${slideType}).`,
    suggestion: 'Check the run log for details and try running again from this lesson.',
  };
}

async function selectMatSelectOption(page, matSelect, optionLabel) {
  await matSelect.click();
  const panelId = await matSelect.getAttribute('aria-controls');
  if (!panelId) throw new Error('Slide Type mat-select has no aria-controls');
  const panel = page.locator(`#${panelId}`);
  await panel.waitFor({ state: 'visible', timeout: 5000 });
  await panel.locator('mat-option', { hasText: optionLabel }).click();
  await panel.waitFor({ state: 'hidden', timeout: 5000 });
}

async function pasteIntoInput(page, locator, text) {
  await page.evaluate(async value => {
    await navigator.clipboard.writeText(value);
  }, text);
  await locator.click();
  await locator.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
  await locator.evaluate(el => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function selectMatSelectOptionByIndex(page, matSelect, optionIndex) {
  await matSelect.click();
  const panelId = await matSelect.getAttribute('aria-controls');
  if (!panelId) throw new Error('mat-select has no aria-controls');
  const panel = page.locator(`#${panelId}`);
  await panel.waitFor({ state: 'visible', timeout: 10000 });
  const options = panel.locator('mat-option');
  const count = await options.count();
  if (count === 0) throw new Error('No mat-options found.');
  const idx = Math.min(Math.max(optionIndex, 0), count - 1);
  await options.nth(idx).click();
  await panel.waitFor({ state: 'hidden', timeout: 10000 });
}

async function clearOverlays(page) {
  const backdrops = page.locator('.cdk-overlay-backdrop');
  if (await backdrops.count() > 0) {
    await page.keyboard.press('Escape').catch(() => {});
    await backdrops.first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
}

async function waitLessonInteractive(page) {
  const newSlideBtn = page.getByRole('button', { name: /new slide/i });
  await newSlideBtn.waitFor({ state: 'visible', timeout: 10000 });
  const backdrops = page.locator('.cdk-overlay-backdrop');
  if (await backdrops.count() > 0) {
    await backdrops.first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
  await page.waitForTimeout(300);
}

async function forceDirtyViaSlideType(page) {
  const slideTypeSelect = page.locator('mat-select[formcontrolname="slideType"]').first();
  await slideTypeSelect.waitFor({ state: 'visible', timeout: 10000 });
  await slideTypeSelect.click();
  await page.keyboard.press('Escape');
  await clearOverlays(page);
}

async function waitForCountIncrease(locator, beforeCount, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const current = await locator.count();
    if (current > beforeCount) return current;
    await locator.page().waitForTimeout(50);
  }
  throw new Error(`Timeout waiting for count to increase (before=${beforeCount})`);
}

function slideMatchKeys(fullTitle) {
  const t = (fullTitle || '').trim();
  const prefix28 = t.slice(0, 28).trim();
  const firstWords = t.split(/\s+/).slice(0, 6).join(' ');
  return [...new Set([prefix28, firstWords].filter(Boolean))];
}

async function findSlideOptionByKeys(page, fullTitle, timeout = 20000) {
  const keys = slideMatchKeys(fullTitle);
  const start = Date.now();
  const vscroll = page.locator('cdk-virtual-scroll-viewport').first();
  const listFallback = page.locator('mat-selection-list, .mat-selection-list').first();
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
  throw new Error(`Slide did not appear in slide list: "${fullTitle}"`);
}

async function confirmNewSlideDialog(dialog, nameInput) {
  const primary = dialog.locator('.mat-dialog-actions button.mat-primary').first();
  if (await primary.count().catch(() => 0)) { await primary.click(); return; }
  await nameInput.press('Enter');
}

async function saveWithRetry(page, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await forceDirtyViaSlideType(page);
    const saveEnabled = page
      .locator('button.mat-raised-button.mat-primary:has-text("Save"):not([disabled])')
      .first();
    await saveEnabled.waitFor({ state: 'visible', timeout: 10000 });
    await clearOverlays(page);
    await saveEnabled.click();
    await page.waitForTimeout(1200);
    await waitLessonInteractive(page);
    const saveStillEnabled = await page
      .locator('button.mat-raised-button.mat-primary:has-text("Save"):not([disabled])')
      .first().isVisible().catch(() => false);
    if (!saveStillEnabled) return;
    await clearOverlays(page);
    if (attempt === maxAttempts) throw new Error('Save did not stabilize after retries.');
  }
}

async function clickCorrectCheckboxForChoice(choiceTextarea) {
  const cb = choiceTextarea.locator('xpath=preceding::mat-checkbox[1]');
  await cb.waitFor({ state: 'visible', timeout: 10000 });
  await cb.scrollIntoViewIfNeeded().catch(() => {});
  const label = cb.locator('label.mat-checkbox-layout').first();
  if (await label.count().catch(() => 0)) {
    await label.click();
  } else {
    const inner = cb.locator('.mat-checkbox-inner-container').first();
    await inner.click({ force: true });
  }
  const input = cb.locator('input[type="checkbox"]').first();
  if (await input.count().catch(() => 0)) {
    const checked = await input.evaluate(el => el.checked).catch(() => false);
    if (!checked) await label.click({ force: true }).catch(() => {});
  }
}

async function fillAngularTextarea(locator, value) {
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.evaluate((el, v) => {
    el.focus(); el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }, value);
}

// fillMatTextarea removed -- use fillAngularTextarea (identical function)

async function openLessonByTitle(page, lessonTitle) {
  await page.click('text=Lessons');
  await page.waitForTimeout(1500);
  const searchInput = page.locator('input').first();
  await searchInput.fill('');
  await fillAngularTextarea(searchInput, lessonTitle);
  await searchInput.press('Enter');
  await page.waitForTimeout(1500);
  await page.locator(`text=${lessonTitle}`).first().click();
  await page.waitForTimeout(2000);
  emitLog(`Lesson opened: ${lessonTitle}`);
}

// ============================
// MAIN
// ============================
async function main() {
  const completed = loadCompletedKeys();
  emitLog(`Loaded ${completed.size} completed slide(s) from previous runs`);

  const browser = await chromium.launch({ headless: false, slowMo: 40 });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  const page = await context.newPage();

  // Capture screenshots on page errors
  page.on('pageerror', err => emitLog(`Page error: ${err.message}`, 'warn'));

  await page.goto(LMS_URL, { waitUntil: 'domcontentloaded' });

  // Wait for the user to log in. LEAP redirects unauthenticated requests to /login
  // and redirects back to the root URL after a successful login. Watching for the
  // root URL is sufficient -- an unauthenticated session never reaches it.
  emitLog('Waiting for login... please log in to LEAP in the browser window that just opened.');
  emit({ type: 'login_waiting' });

  // Wait for the URL to reach the dashboard root AND for a nav element that only
  // exists when authenticated. This prevents false positives from intermediate
  // redirect URLs that briefly hit the root during the login flow.
  await page.waitForURL('https://control-center.theceshop.com/', {
    timeout: 5 * 60 * 1000,
    waitUntil: 'domcontentloaded',
  });

  // Secondary confirmation: wait for the Lessons nav link which only renders
  // when the user is fully authenticated and the dashboard has loaded.
  // This is the same element openLessonByTitle clicks to navigate.
  await page.locator('text=Lessons').first().waitFor({
    state: 'visible',
    timeout: 60 * 1000,
  });

  emitLog('Login detected. Starting import...');

  let foundStartLesson = !START_FROM_LESSON;
  let lessonIndex = 0;
  const allLessons = courseData.course.units.flatMap(u => u.lessons);
  const totalLessons = allLessons.length;

  for (const unit of courseData.course.units) {
    for (const lesson of unit.lessons) {
      const lessonTitle = lesson.title;
      lessonIndex++;

      if (!foundStartLesson) {
        if (lessonTitle === START_FROM_LESSON) {
          foundStartLesson = true;
        } else {
          emitLog(`Skipping lesson (before start): ${lessonTitle}`);
          continue;
        }
      }

      // Check whether every slide in this lesson is already completed.
      // If all are done in Normal mode, skip the entire lesson without opening it.
      const lessonSlides = lesson.slides.filter(s => SLIDE_TYPE_MAP[s.slide_type]);
      const totalSlidesInLesson = lessonSlides.length;

      if (!FORCE_REBUILD && totalSlidesInLesson > 0) {
        const allDone = lessonSlides.every(s => completed.has(slideKey(lessonTitle, s.slide_name)));
        if (allDone) {
          emitLog(`Skipping lesson (all slides complete): ${lessonTitle}`);
          emit({ type: 'lesson_skip', lessonTitle, lessonIndex, totalLessons, reason: 'all_slides_complete' });
          continue;
        }
      }

      emit({ type: 'lesson_start', lessonTitle, lessonIndex, totalLessons });

      await openLessonByTitle(page, lessonTitle);

      let slideIndex = 0;

      for (const slide of lesson.slides) {
        const slideTypeLabel = SLIDE_TYPE_MAP[slide.slide_type];
        if (!slideTypeLabel) continue;

        slideIndex++;
        const key = slideKey(lessonTitle, slide.slide_name);

        if (!FORCE_REBUILD && completed.has(key)) {
          emitLog(`Skipping completed: ${slide.slide_name}`);
          emit({ type: 'slide_skip', lessonTitle, slideName: slide.slide_name, reason: 'already_completed' });
          continue;
        }

        emit({ type: 'slide_start', lessonTitle, slideName: slide.slide_name, slideType: slide.slide_type, slideIndex, totalSlidesInLesson });

        try {
          await clearOverlays(page);

          // CHECK IF SLIDE ALREADY EXISTS IN THE LESSON
          // Searches by prefix/word keys then verifies BOTH the full slide name
          // AND the slide type match before treating as existing.
          // Full name check prevents prefix collisions (e.g. "Credit Freezes and
          // Transactions" incorrectly matching "Credit Freezes and Transaction
          // Disruptions" via the shared 28-char prefix).
          const slideMatchKeysList = slideMatchKeys(slide.slide_name);
          let existingSlideItem = null;
          for (const matchKey of slideMatchKeysList) {
            const candidates = page.locator('mat-list-option').filter({ hasText: matchKey });
            const count = await candidates.count().catch(() => 0);
            for (let ci = 0; ci < count; ci++) {
              const candidate = candidates.nth(ci);
              if (!(await candidate.isVisible().catch(() => false))) continue;
              // Verify the full slide name matches exactly to avoid prefix collisions
              const candidateText = await candidate.textContent().catch(() => '');
              if (!candidateText.trim().includes(slide.slide_name.trim())) continue;
              // Click to load the slide and verify the type matches
              await clearOverlays(page);
              await candidate.click();
              const typeSelect = page.locator('mat-select[formcontrolname="slideType"]').first();
              await typeSelect.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
              const foundType = await typeSelect.locator('.mat-select-value-text').innerText().catch(() => '');
              if (foundType.trim() === slideTypeLabel) {
                existingSlideItem = candidate;
              }
              break;
            }
            if (existingSlideItem) break;
          }

          if (existingSlideItem) {
            // Slide already exists in LEAP with the correct type from a previous run.
            // Skip settings dialog and save entirely -- content is already correct.
            // Re-filling identical content leaves the form pristine and Save disabled.
            emitLog(`Slide already complete in lesson, skipping: ${slide.slide_name}`);
            emit({ type: 'slide_skip', lessonTitle, slideName: slide.slide_name, reason: 'exists_in_lesson' });
            appendRunLog({ lessonTitle, slideName: slide.slide_name, slideType: slide.slide_type, status: 'SUCCESS', note: 'Skipped -- already exists in lesson' });
            completed.add(key);
            continue;
          } else {
            // CREATE SLIDE SHELL
            await page.getByRole('button', { name: /new slide/i }).click();
            await page.waitForTimeout(300);
            await page.keyboard.press('Enter');

            const dialog = page.locator('mat-dialog-container').last();
            await dialog.waitFor({ state: 'visible', timeout: 5000 });

            const nameInput = dialog.locator('input.mat-input-element').first();
            await nameInput.evaluate((el, value) => {
              el.focus(); el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, slide.slide_name);

            await confirmNewSlideDialog(dialog, nameInput);
            await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

            const slideItem = await findSlideOptionByKeys(page, slide.slide_name, 20000);
            await clearOverlays(page);
            await slideItem.scrollIntoViewIfNeeded().catch(() => {});
            await slideItem.click();
            // Scroll the newly selected slide into view after clicking.
            // In long lessons the slide list has a scrollbar and the new slide
            // lands below the fold. If it's not fully visible when the type
            // dropdown is activated, LEAP's right panel may not have finished
            // loading the correct slide, causing the type selection to fail.
            await slideItem.scrollIntoViewIfNeeded().catch(() => {});
          }

          // SET SLIDE TYPE
          await clearOverlays(page);
          const slideTypeSelect = page.locator('mat-select[formcontrolname="slideType"]').first();
          await slideTypeSelect.waitFor({ state: 'visible', timeout: 10000 });

          // Retry up to 3 times to ensure the slide type commits correctly.
          // Explicitly compares the committed value against expected slideTypeLabel
          // to catch cases where the wrong type was committed (not just missing).
          let typeCommitted = false;
          for (let attempt = 1; attempt <= 3 && !typeCommitted; attempt++) {
            await selectMatSelectOption(page, slideTypeSelect, slideTypeLabel);
            await page.keyboard.press('Escape');
            await clearOverlays(page);
            const committedType = await slideTypeSelect
              .locator('.mat-select-value-text').innerText().catch(() => '');
            if (committedType.trim() === slideTypeLabel) {
              typeCommitted = true;
            } else if (attempt < 3) {
              // Log warning with expected vs found for debugging
              emitLog(`Slide type retry: attempt ${attempt}/3 - expected "${slideTypeLabel}", got "${committedType.trim()}"`, 'warn');
              await page.waitForTimeout(500);
            }
          }
          if (!typeCommitted) {
            const finalType = await slideTypeSelect
              .locator('.mat-select-value-text').innerText().catch(() => '');
            throw new Error(`Failed to set slide type to "${slideTypeLabel}" after 3 attempts. Final value: "${finalType.trim()}"`);
          }

          // OPEN SLIDE SETTINGS
          const slideSettingsBtn = page.getByRole('button', { name: /slide settings/i });
          await slideSettingsBtn.waitFor({ state: 'visible', timeout: 15000 });
          await slideSettingsBtn.click();

          const settingsDialog = page.locator('mat-dialog-container').last();
          await settingsDialog.waitFor({ state: 'visible', timeout: 10000 });

          // TEXT SLIDE
          if (slide.slide_type === 'text_slide') {
            await settingsDialog.locator('button.ck-source-editing-button').click();
            const sourceTextarea = settingsDialog.locator('textarea').first();
            await sourceTextarea.waitFor({ state: 'visible', timeout: 5000 });
            await sourceTextarea.fill(slide.content);
            const okBtn = settingsDialog.locator('.mat-dialog-actions button.mat-primary', { hasText: 'OK' });
            await okBtn.waitFor({ state: 'visible', timeout: 10000 });
            await okBtn.click();
            await settingsDialog.waitFor({ state: 'hidden', timeout: 15000 });
            await clearOverlays(page);
          }

          // MATCHING SLIDE
          if (slide.slide_type === 'matching') {
            const sourceBtn = settingsDialog.locator('button.ck-source-editing-button');
            await sourceBtn.waitFor({ state: 'visible', timeout: 10000 });
            await sourceBtn.click();
            const qSourceTextarea = settingsDialog.locator('textarea').first();
            await qSourceTextarea.waitFor({ state: 'visible', timeout: 10000 });
            await qSourceTextarea.fill(slide.question_body);
            await sourceBtn.click();
            const choiceInputs = settingsDialog.locator('textarea[aria-label="Choice"]');
            const matchInputs = settingsDialog.locator('textarea[aria-label="Match"]');
            let optionIndex = 0;
            const existingRows = await choiceInputs.count();
            for (; optionIndex < existingRows && optionIndex < slide.options.length; optionIndex++) {
              await choiceInputs.nth(optionIndex).fill(slide.options[optionIndex].text);
              await matchInputs.nth(optionIndex).fill(slide.options[optionIndex].match);
            }
            for (; optionIndex < slide.options.length; optionIndex++) {
              const addBtn = settingsDialog.getByRole('button', { name: /^add question$/i });
              await addBtn.scrollIntoViewIfNeeded();
              await addBtn.waitFor({ state: 'visible', timeout: 10000 });
              const before = await choiceInputs.count();
              await addBtn.click();
              await waitForCountIncrease(choiceInputs, before, 10000);
              // Wait for the new input to be visible and interactive after count increased
              await choiceInputs.nth(before).waitFor({ state: 'visible', timeout: 3000 });
              await matchInputs.nth(before).waitFor({ state: 'visible', timeout: 3000 });
              await choiceInputs.nth(before).fill(slide.options[optionIndex].text);
              await matchInputs.nth(before).fill(slide.options[optionIndex].match);
            }
            if (slide.correct_feedback) {
              const correctFb = settingsDialog.locator('textarea[aria-label="Correct Feedback"], textarea[formcontrolname="correctFeedback"]').first();
              await correctFb.scrollIntoViewIfNeeded().catch(() => {});
              await correctFb.waitFor({ state: 'visible', timeout: 10000 });
              await correctFb.fill(slide.correct_feedback);
            }
            if (slide.incorrect_feedback) {
              const incorrectFb = settingsDialog.locator('textarea[aria-label="Incorrect Feedback"], textarea[formcontrolname="incorrectFeedback"]').first();
              await incorrectFb.scrollIntoViewIfNeeded().catch(() => {});
              await incorrectFb.waitFor({ state: 'visible', timeout: 10000 });
              await incorrectFb.fill(slide.incorrect_feedback);
            }
            const okBtn = settingsDialog.locator('.mat-dialog-actions button.mat-primary', { hasText: 'OK' });
            await okBtn.waitFor({ state: 'visible', timeout: 10000 });
            await okBtn.click();
            await settingsDialog.waitFor({ state: 'hidden', timeout: 15000 });
            await clearOverlays(page);
          }

          // TRUE/FALSE SLIDE
          if (slide.slide_type === 'true_false') {
            async function setMatInputValue(locator, value) {
              await locator.waitFor({ state: 'visible', timeout: 10000 });
              await locator.scrollIntoViewIfNeeded().catch(() => {});
              await locator.evaluate((el, v) => {
                el.focus(); el.value = v;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.blur();
              }, value);
            }
            const questionTextareas = settingsDialog.locator('xpath=.//mat-form-field[.//mat-label[contains(normalize-space(.),"Question")]]//textarea');
            await questionTextareas.first().waitFor({ state: 'visible', timeout: 15000 });
            if (slide.question_body) {
              const sourceBtn = settingsDialog.locator('button.ck-source-editing-button').first();
              await sourceBtn.waitFor({ state: 'visible', timeout: 10000 });
              await sourceBtn.click();
              const sourceTextarea = settingsDialog.locator('.ck-source-editing-area textarea').first();
              await sourceTextarea.waitFor({ state: 'visible', timeout: 10000 });
              await sourceTextarea.fill(String(slide.question_body));
              await sourceBtn.click();
            }
            async function clickTfRadioForQuestion(qTextarea, tfValue) {
              const row = qTextarea.locator('xpath=ancestor::div[@fxlayout="row" and @fxlayoutgap="10px"][1]');
              const input = row.locator(`input.mat-radio-input[value="${tfValue}"]`).first();
              await input.waitFor({ state: 'visible', timeout: 10000 });
              const label = input.locator('xpath=ancestor::label[contains(@class,"mat-radio-label")][1]');
              if (await label.count().catch(() => 0)) { await label.click(); }
              else { await input.click({ force: true }); }
            }
            if (slide.feedbackBy && String(slide.feedbackBy).toLowerCase() === 'choice') {
              const feedbackBySelect = settingsDialog.locator('mat-form-field').filter({ hasText: /feedback by/i }).locator('mat-select').first();
              await feedbackBySelect.waitFor({ state: 'visible', timeout: 10000 });
              await selectMatSelectOption(page, feedbackBySelect, 'Choice');
            }
            if (slide.true_label && slide.true_label !== 'True') {
              const trueLabel = settingsDialog.locator('input[aria-label="True Label"]').first();
              if (await trueLabel.count().catch(() => 0)) await setMatInputValue(trueLabel, slide.true_label);
            }
            if (slide.false_label && slide.false_label !== 'False') {
              const falseLabel = settingsDialog.locator('input[aria-label="False Label"]').first();
              if (await falseLabel.count().catch(() => 0)) await setMatInputValue(falseLabel, slide.false_label);
            }
            const addQuestionBtn = settingsDialog.getByRole('button', { name: /add question/i });
            await addQuestionBtn.waitFor({ state: 'visible', timeout: 10000 });
            if (!Array.isArray(slide.options) || slide.options.length === 0) throw new Error('True/False slide has no options[].');
            const existingTfRows = await questionTextareas.count();
            const rowsNeeded = slide.options.length - existingTfRows;

            for (let i = 0; i < rowsNeeded; i++) {
              const before = await questionTextareas.count();
              await addQuestionBtn.scrollIntoViewIfNeeded().catch(() => {});
              await addQuestionBtn.click();
              await waitForCountIncrease(questionTextareas, before, 15000);
              // Wait for the new textarea to be visible and interactive after count increased
              await questionTextareas.nth(before).waitFor({ state: 'visible', timeout: 3000 });
            }
            for (let i = 0; i < slide.options.length; i++) {
              const opt = slide.options[i];
              const q = questionTextareas.nth(i);
              await q.scrollIntoViewIfNeeded().catch(() => {});
              await q.waitFor({ state: 'visible', timeout: 10000 });
              await q.fill(opt.text);
              await clickTfRadioForQuestion(q, opt.is_correct ? 'true' : 'false');
              if (slide.feedbackBy && String(slide.feedbackBy).toLowerCase() === 'choice' && opt.feedback) {
                // The outerHTML shows Question+radios live in an inner fxlayout="row",
                // which is a child of an fxlayout="column" div. The Feedback textarea
                // is a sibling of that inner row -- added as a second child of the column
                // when feedbackBy=Choice. Climb to the column wrapper, not the inner row.
                const column = q.locator('xpath=ancestor::div[@fxlayout="column"][1]');
                const feedbackTextarea = column.getByRole('textbox', { name: /feedback/i }).first();
                const exists = await feedbackTextarea.count().catch(() => 0);
                if (exists) {
                  await feedbackTextarea.scrollIntoViewIfNeeded().catch(() => {});
                  await setMatInputValue(feedbackTextarea, opt.feedback);
                }
              }
            }
            // Always write correct/incorrect feedback regardless of feedbackBy mode.
            // LEAP renders these fields in both question and choice feedback modes.
            if (slide.correct_feedback) {
              const correctField = settingsDialog.locator('mat-form-field').filter({ hasText: /Correct/i }).locator('textarea').first();
              if (await correctField.count().catch(() => 0)) await setMatInputValue(correctField, slide.correct_feedback);
            }
            if (slide.incorrect_feedback) {
              const incorrectField = settingsDialog.locator('mat-form-field').filter({ hasText: /Incorrect/i }).locator('textarea').first();
              if (await incorrectField.count().catch(() => 0)) {
                await incorrectField.scrollIntoViewIfNeeded().catch(() => {});
                await setMatInputValue(incorrectField, slide.incorrect_feedback);
              }
            }
            const okBtn = settingsDialog.locator('.mat-dialog-actions button.mat-primary', { hasText: 'OK' });
            await okBtn.waitFor({ state: 'visible', timeout: 10000 });
            await okBtn.click();
            try {
              await settingsDialog.waitFor({ state: 'hidden', timeout: 15000 });
            } catch {
              const errors = await settingsDialog.locator('mat-error').allTextContents().catch(() => []);
              throw new Error(`True/False dialog did not close. Errors: ${errors.join(' | ') || 'unknown'}`);
            }
            await clearOverlays(page);
          }

          // MULTIPLE CHOICE SLIDE
          if (slide.slide_type === 'multiple_choice') {
            const sourceBtn = settingsDialog.locator('button.ck-source-editing-button');
            await sourceBtn.waitFor({ state: 'visible', timeout: 10000 });
            await sourceBtn.click();
            const qSourceTextarea = settingsDialog.locator('textarea').first();
            await qSourceTextarea.waitFor({ state: 'visible', timeout: 10000 });
            await qSourceTextarea.fill(slide.question_body);
            await sourceBtn.click();
            // Check both camelCase (feedbackBy) and snake_case (feedback_by) --
            // different JSON generators use different conventions
            const feedbackByField = slide.feedbackBy || slide.feedback_by || '';
            const wantsChoiceFeedback =
              String(feedbackByField).toLowerCase() === 'choice' ||
              (Array.isArray(slide.options) && slide.options.some(o => o && o.feedback));
            if (wantsChoiceFeedback) {
              const feedbackBySelect = settingsDialog.locator('mat-form-field').filter({ hasText: /feedback by/i }).locator('mat-select').first();
              await feedbackBySelect.waitFor({ state: 'visible', timeout: 10000 });
              await selectMatSelectOption(page, feedbackBySelect, 'Choice');
              // No Escape here -- selectMatSelectOption already closes the dropdown panel.
              // Pressing Escape inside an open dialog dismisses the entire dialog, not a backdrop.
            }
            const addChoiceBtn = settingsDialog.getByRole('button', { name: /^add choice$/i });
            await addChoiceBtn.waitFor({ state: 'visible', timeout: 10000 });
            const choiceFields = settingsDialog.locator('textarea[aria-label="Choice"]');
            const feedbackFields = settingsDialog.locator('textarea[aria-label="Feedback"]');
            for (let i = 0; i < slide.options.length; i++) {
              const before = await choiceFields.count();
              await addChoiceBtn.click();
              await waitForCountIncrease(choiceFields, before, 10000);
              // Wait for the new choice field to be visible and interactive after count increased
              await choiceFields.nth(before).waitFor({ state: 'visible', timeout: 3000 });
              if (wantsChoiceFeedback) {
                const fbCount = await feedbackFields.count();
                if (fbCount <= before) await waitForCountIncrease(feedbackFields, fbCount, 10000).catch(() => {});
                // Wait for the new feedback field to be visible and interactive after count increased
                if (fbCount <= before) await feedbackFields.nth(fbCount).waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
              }
            }
            for (let i = 0; i < slide.options.length; i++) {
              const opt = slide.options[i];
              const cf = choiceFields.nth(i);
              await cf.fill(opt.text);
              if (opt.is_correct === true) await clickCorrectCheckboxForChoice(cf);
              if (wantsChoiceFeedback && opt.feedback) await feedbackFields.nth(i).fill(opt.feedback);
            }
            if (!slide.options.some(o => o && o.is_correct === true)) throw new Error('Multiple choice requires at least one is_correct=true option.');
            // Question-level correct/incorrect feedback -- always written regardless
            // of feedbackBy mode. LEAP shows these fields in both question and choice
            // feedback modes simultaneously on the Multiple Choice dialog.
            if (slide.correct_feedback) {
              const correctFb = settingsDialog.locator(
                'textarea[aria-label="Correct Feedback"], textarea[formcontrolname="correctFeedback"]'
              ).first();
              if (await correctFb.count().catch(() => 0)) {
                await correctFb.scrollIntoViewIfNeeded().catch(() => {});
                await correctFb.waitFor({ state: 'visible', timeout: 10000 });
                await correctFb.fill(slide.correct_feedback);
              }
            }
            if (slide.incorrect_feedback) {
              const incorrectFb = settingsDialog.locator(
                'textarea[aria-label="Incorrect Feedback"], textarea[formcontrolname="incorrectFeedback"]'
              ).first();
              if (await incorrectFb.count().catch(() => 0)) {
                await incorrectFb.scrollIntoViewIfNeeded().catch(() => {});
                await incorrectFb.waitFor({ state: 'visible', timeout: 10000 });
                await incorrectFb.fill(slide.incorrect_feedback);
              }
            }
            const okBtn = settingsDialog.locator('.mat-dialog-actions button.mat-primary', { hasText: 'OK' });
            await okBtn.waitFor({ state: 'visible', timeout: 10000 });
            await okBtn.click();
            await settingsDialog.waitFor({ state: 'hidden', timeout: 15000 });
            await clearOverlays(page);
          }

          // SORTING SLIDE
          if (slide.slide_type === 'sorting') {
            const addItemBtn = settingsDialog.getByRole('button', { name: /add item/i }).first();
            const addTargetBtn = settingsDialog.getByRole('button', { name: /add target/i }).first();
            await addItemBtn.waitFor({ state: 'visible', timeout: 10000 });
            await addTargetBtn.waitFor({ state: 'visible', timeout: 10000 });
            if (slide.question_body) {
              const sourceBtn = settingsDialog.locator('button.ck-source-editing-button').first();
              if (await sourceBtn.count().catch(() => 0)) {
                await sourceBtn.click();
                const sourceTextarea = settingsDialog.locator('.ck-source-editing-area textarea').first();
                await sourceTextarea.waitFor({ state: 'visible', timeout: 10000 });
                await sourceTextarea.fill(String(slide.question_body));
                await sourceBtn.click();
              }
            }
            if (!Array.isArray(slide.categories) || slide.categories.length === 0) throw new Error('Sorting slide missing categories[].');
            if (!Array.isArray(slide.items) || slide.items.length === 0) throw new Error('Sorting slide missing items[].');
            async function getExistingSelectIds() {
              const selects = settingsDialog.locator('mat-select');
              const count = await selects.count();
              const ids = new Set();
              for (let n = 0; n < count; n++) {
                const id = await selects.nth(n).getAttribute('id').catch(() => null);
                if (id) ids.add(id);
              }
              return ids;
            }
            async function waitForNewSelect(beforeIds, timeout = 15000) {
              const start = Date.now();
              while (Date.now() - start < timeout) {
                const selects = settingsDialog.locator('mat-select');
                const count = await selects.count();
                for (let n = 0; n < count; n++) {
                  const id = await selects.nth(n).getAttribute('id').catch(() => null);
                  if (id && !beforeIds.has(id)) return settingsDialog.locator(`mat-select#${id}`).first();
                }
                await page.waitForTimeout(50);
              }
              throw new Error('Timed out waiting for new mat-select after Add button click');
            }
            async function addSortRow(clickBtn, iconIndex, labelText, logLabel) {
              const beforeIds = await getExistingSelectIds();
              await clickBtn.click();
              const newSelect = await waitForNewSelect(beforeIds);
              const rowDiv = newSelect.locator('xpath=ancestor::div[@fxlayout="row" and @fxlayoutgap="10px"][1]');
              const labelInput = rowDiv.locator('input[aria-label="Label"]').first();
              await newSelect.waitFor({ state: 'visible', timeout: 10000 });
              await selectMatSelectOptionByIndex(page, newSelect, iconIndex);
              await labelInput.waitFor({ state: 'visible', timeout: 10000 });
              await labelInput.fill(labelText);
              await labelInput.evaluate(el => {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              });
              emitLog(`  ${logLabel}: "${labelText}"`);
            }
            for (let i = 0; i < slide.categories.length; i++) {
              await addSortRow(addTargetBtn, i, String(slide.categories[i]), `Target[${i}]`);
            }
            for (let i = 0; i < slide.items.length; i++) {
              const item = slide.items[i];
              const categoryIndex = slide.categories.indexOf(item.correct_category);
              if (categoryIndex < 0) throw new Error(
                `Sorting item "${item.text}" correct_category="${item.correct_category}" not in categories[].\n` +
                `Available: ${JSON.stringify(slide.categories)}`
              );
              await addSortRow(addItemBtn, categoryIndex, String(item.text), `Item[${i}]`);
            }
            if (slide.correct_feedback) {
              const correctFb = settingsDialog.locator('textarea[aria-label="Correct Feedback"], textarea[formcontrolname="correctFeedback"]').first();
              if (await correctFb.count().catch(() => 0)) {
                await correctFb.scrollIntoViewIfNeeded().catch(() => {});
                await fillAngularTextarea(correctFb, slide.correct_feedback);
              }
            }
            if (slide.incorrect_feedback) {
              const incorrectFb = settingsDialog.locator('textarea[aria-label="Incorrect Feedback"], textarea[formcontrolname="incorrectFeedback"]').first();
              if (await incorrectFb.count().catch(() => 0)) {
                await incorrectFb.scrollIntoViewIfNeeded().catch(() => {});
                await fillAngularTextarea(incorrectFb, slide.incorrect_feedback);
              }
            }
            const okBtn = settingsDialog.locator('.mat-dialog-actions button.mat-primary', { hasText: 'OK' });
            await okBtn.waitFor({ state: 'visible', timeout: 10000 });
            await okBtn.click();
            await settingsDialog.waitFor({ state: 'hidden', timeout: 15000 });
            await clearOverlays(page);
          }

          // SAVE
          await saveWithRetry(page, 3);

          emit({ type: 'slide_success', lessonTitle, slideName: slide.slide_name, slideType: slide.slide_type });
          appendRunLog({ lessonTitle, slideName: slide.slide_name, slideType: slide.slide_type, status: 'SUCCESS' });
          completed.add(key);

        } catch (err) {
          // Capture failure artifacts
          const safeName = slide.slide_name.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
          const screenshotPath = path.join(RUN_DIR, `FAIL_${safeName}.png`);
          const htmlPath = path.join(RUN_DIR, `FAIL_${safeName}.html`);
          try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch {}
          try { fs.writeFileSync(htmlPath, await page.content(), 'utf8'); } catch {}

          // Translate the technical error to user-friendly message
          const translated = translateError(err, {
            slideName: slide.slide_name,
            slideType: slide.slide_type,
            lessonTitle: lessonTitle,
          });

          emit({
            type: 'slide_fail',
            lessonTitle,
            slideName: slide.slide_name,
            slideType: slide.slide_type,
            error: err.message,                       // keep technical error for logs
            userMessage: translated.userMessage,      // new plain language
            suggestion: translated.suggestion,         // new action to take
            screenshotFile: path.basename(screenshotPath),
            htmlFile: path.basename(htmlPath),
          });

          appendRunLog({ lessonTitle, slideName: slide.slide_name, slideType: slide.slide_type, status: 'FAIL', error: err.message });

          await browser.close();
          process.exit(1);
        }
      }

      emit({ type: 'lesson_end', lessonTitle, lessonIndex, totalLessons });
    }
  }

  emit({ type: 'run_complete', message: 'All lessons processed successfully.' });
  await browser.close();
  process.exit(0);
}

main().catch(async err => {
  emit({ type: 'fatal', message: err.message });
  process.exit(1);
});