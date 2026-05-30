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

function slideKey(lessonTitle, slideName, slideType) {
  // Include slideType so two slides with the same title but different types
  // (e.g. a text slide and a multiple choice) are treated as distinct entries
  // and neither is skipped because the other already completed.
  return `${(lessonTitle || '').trim()}\x00${(slideName || '').trim()}\x00${(slideType || '').trim()}`;
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
        completed.add(slideKey(rec.lessonTitle, rec.slideName, rec.slideType));
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
  complete_the_story: 'Complete Story',
  survey: 'Survey',
  student_poll: 'Student Poll',
};

// ============================
// Helpers (identical to original script)
// ============================
async function selectMatSelectOption(page, matSelect, optionLabel) {
  await matSelect.click();
  const panelId = await matSelect.getAttribute('aria-controls');
  if (!panelId) throw new Error('Slide Type mat-select has no aria-controls');
  const panel = page.locator(`#${panelId}`);
  await panel.waitFor({ state: 'visible', timeout: 5000 });
  // Scroll the target option into view before clicking -- options near the
  // bottom of long dropdowns (e.g. "Complete the Story") may be below the
  // visible area and will timeout if clicked without scrolling first.
  const option = panel.locator('mat-option', { hasText: optionLabel }).first();
  await option.waitFor({ state: 'attached', timeout: 5000 });
  await option.scrollIntoViewIfNeeded().catch(() => {});
  await option.click();
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
        const allDone = lessonSlides.every(s => completed.has(slideKey(lessonTitle, s.slide_name, s.slide_type)));
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
        const key = slideKey(lessonTitle, slide.slide_name, slide.slide_type);

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
              // Click to load the slide and verify the slide type matches.
              // For duplicate-title slides (same name, different type) we must
              // check ALL matching candidates -- not just the first one.
              // The old code broke out after the first match regardless of type,
              // which left LEAP showing the wrong slide and caused the delay.
              await clearOverlays(page);
              await candidate.click();
              const typeSelect = page.locator('mat-select[formcontrolname="slideType"]').first();
              await typeSelect.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
              const foundType = await typeSelect.locator('.mat-select-value-text').innerText().catch(() => '');
              if (foundType.trim() === slideTypeLabel) {
                existingSlideItem = candidate;
                break; // correct type found -- stop searching
              }
              // Type didn't match -- this is a different slide with the same title.
              // Do NOT break -- continue checking remaining candidates.
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

          // Select the slide type and verify it committed. If it didn't stick
          // (empty string returned) retry once after a short wait.
          // This handles the Angular form init race where the select is visible
          // but the reactive form control hasn't finished wiring up yet.
          await selectMatSelectOption(page, slideTypeSelect, slideTypeLabel);
          await page.keyboard.press('Escape');
          await clearOverlays(page);

          const committedType = await slideTypeSelect
            .locator('.mat-select-value-text').innerText().catch(() => '');
          if (!committedType.trim()) {
            // Value didn't commit -- wait for Angular to settle then retry once
            await page.waitForTimeout(800);
            await selectMatSelectOption(page, slideTypeSelect, slideTypeLabel);
            await page.keyboard.press('Escape');
            await clearOverlays(page);
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

            if (!Array.isArray(slide.options) || !slide.options.length) throw new Error('Matching slide has no options[].');

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
            // True Label -- aria-label="True Label" formcontrolname="trueLabel"
            // Always fill both labels. LEAP requires them even when using defaults,
            // and waitFor ensures Angular has rendered the fields before we write.
            const trueLabelField = settingsDialog.locator('input[formcontrolname="trueLabel"]').first();
            await trueLabelField.waitFor({ state: 'visible', timeout: 8000 });
            await setMatInputValue(trueLabelField, slide.true_label || 'True');

            // False Label -- aria-label="False Label" formcontrolname="falseLabel"
            const falseLabelField = settingsDialog.locator('input[formcontrolname="falseLabel"]').first();
            await falseLabelField.waitFor({ state: 'visible', timeout: 8000 });
            await setMatInputValue(falseLabelField, slide.false_label || 'False');
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
            }
            for (let i = 0; i < slide.options.length; i++) {
              const opt = slide.options[i];
              const q = questionTextareas.nth(i);
              await q.scrollIntoViewIfNeeded().catch(() => {});
              await q.waitFor({ state: 'visible', timeout: 10000 });
              await q.fill(opt.text);
              await clickTfRadioForQuestion(q, (opt.is_correct || opt.correct) ? 'true' : 'false');
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
              if (wantsChoiceFeedback) {
                const fbCount = await feedbackFields.count();
                if (fbCount <= before) await waitForCountIncrease(feedbackFields, fbCount, 10000).catch(() => {});
              }
            }
            for (let i = 0; i < slide.options.length; i++) {
              const opt = slide.options[i];
              const cf = choiceFields.nth(i);
              await cf.fill(opt.text);
              if (opt.is_correct === true || opt.correct === true) await clickCorrectCheckboxForChoice(cf);
              if (wantsChoiceFeedback && opt.feedback) await feedbackFields.nth(i).fill(opt.feedback);
            }
            if (!slide.options.some(o => o && (o.is_correct === true || o.correct === true))) throw new Error('Multiple choice requires at least one correct option (is_correct or correct field).');
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

          // COMPLETE THE STORY SLIDE
          if (slide.slide_type === 'complete_the_story') {
            // Step 1: Build the story body with actual answers inside brackets.
            // The storyboard stores [[Placeholder N]] in story_body with a
            // separate placeholders[] array mapping each label to its answer.
            // LEAP requires the actual answer text inside the brackets so that
            // it auto-generates the Choice rows -- e.g. [[ownership interest]]
            // not [[Placeholder 4]]. Swap every placeholder label for its answer.
            let storyText = slide.story_body || '';
            if (Array.isArray(slide.placeholders)) {
              for (const ph of slide.placeholders) {
                if (ph.placeholder && ph.answer) {
                  // Replace [[Placeholder N]] with [[actual answer]]
                  // Use a regex so spacing variations are handled
                  // Simple literal replace -- split on exact placeholder string and rejoin
                  storyText = storyText.split(ph.placeholder).join(`[[${ph.answer}]]`);
                }
              }
            }
            // Ensure all brackets are correct -- each answer must have exactly [[answer]]
            emitLog(`  Story text prepared (${storyText.length} chars)`);

            // Step 2: Paste story text into CKEditor source mode
            const ckSourceBtn = settingsDialog.locator('button.ck-source-editing-button').first();
            await ckSourceBtn.waitFor({ state: 'visible', timeout: 10000 });
            await ckSourceBtn.click();
            const ckTextarea = settingsDialog.locator('.ck-source-editing-area textarea, textarea.ck-source-editing-area').first()
              .or(settingsDialog.locator('textarea').first());
            await ckTextarea.waitFor({ state: 'visible', timeout: 10000 });
            await ckTextarea.fill(storyText);
            // Click source button again to switch back to rich text view.
            // LEAP parses [[brackets]] and auto-generates Choice rows when
            // switching from source mode back to rich text mode.
            await ckSourceBtn.click();

            // Step 3: Wait for LEAP to render the Choice input rows.
            // LEAP generates one input[aria-label="Choice Text"] per [[bracket]] found.
            const expectedChoices = (Array.isArray(slide.placeholders) ? slide.placeholders.length : 0);
            if (expectedChoices > 0) {
              await page.waitForFunction(
                ([dialogSelector, expected]) => {
                  const dialog = document.querySelector(dialogSelector);
                  if (!dialog) return false;
                  return dialog.querySelectorAll('input[aria-label="Choice Text"]').length >= expected;
                },
                ['mat-dialog-container', expectedChoices],
                { timeout: 15000 }
              ).catch(() => emitLog('  Warning: choice rows may not have fully rendered'));
            }

            // Step 4: Fill each Choice input with the answer text.
            // The row label (left column) matches the answer we put in brackets.
            // We fill by position since all inputs share aria-label="Choice Text".
            const choiceInputs = settingsDialog.locator('input[aria-label="Choice Text"]');
            const choiceCount = await choiceInputs.count().catch(() => 0);
            emitLog(`  Found ${choiceCount} choice input(s)`);
            for (let i = 0; i < choiceCount; i++) {
              const input = choiceInputs.nth(i);
              const currentVal = await input.inputValue().catch(() => '');
              // If LEAP already populated the field from the bracket text, skip
              if (currentVal.trim()) {
                emitLog(`  Choice[${i}]: already filled ("${currentVal.substring(0,30)}")`);
                continue;
              }
              // Otherwise find the matching answer by looking at the row label
              // The label is a mat-label or span to the left of the input
              const row = input.locator('xpath=ancestor::div[@fxlayout="row"][1]').or(
                          input.locator('xpath=ancestor::div[contains(@class,"mat-form-field")]/ancestor::div[1]'));
              const labelText = await row.locator('mat-label, label, span').first().innerText().catch(() => '');
              const matchingPh = Array.isArray(slide.placeholders)
                ? slide.placeholders.find(p => p.answer && p.answer.toLowerCase() === labelText.trim().toLowerCase())
                : null;
              const fillValue = matchingPh ? matchingPh.answer : (
                Array.isArray(slide.placeholders) && slide.placeholders[i] ? slide.placeholders[i].answer : ''
              );
              if (fillValue) {
                await fillAngularTextarea(input, fillValue);
                emitLog(`  Choice[${i}]: filled "${fillValue.substring(0,40)}"`);
              }
            }

            // Step 5: Fill correct/incorrect feedback
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

          // SURVEY SLIDE
          if (slide.slide_type === 'survey') {
            // Survey structure:
            // - CKEditor at bottom = question/instructions body
            // - Left panel = option list (click + Option to add each one)
            // - Right panel = fields for selected option: Type, Text, Question
            // - Child options = nested under a parent option via + Child Option
            //
            // Flow per option:
            //   1. Click + Option (new row auto-selected)
            //   2. Set Type dropdown (Button or Text)
            //   3. Fill Text textarea (the button label)
            //   4. Fill Question textarea (the follow-up response text)
            //   5. If option has children: click + Child Option, fill same fields

            // Step 1: Paste question body into CKEditor
            const ckSourceBtn = settingsDialog.locator('button.ck-source-editing-button').first();
            await ckSourceBtn.waitFor({ state: 'visible', timeout: 10000 });
            await ckSourceBtn.click();
            const ckTextarea = settingsDialog.locator('.ck-source-editing-area textarea').first()
              .or(settingsDialog.locator('textarea.ck-source-editing-area').first());
            await ckTextarea.waitFor({ state: 'visible', timeout: 10000 });
            await ckTextarea.fill(slide.question_body || '');
            await ckSourceBtn.click();
            await page.waitForTimeout(300);

            // Helper: fill the right-panel fields for the currently selected option
            async function fillOptionFields(type, text, question) {
              // Type dropdown -- mat-label is a SIBLING of mat-select inside
              // mat-form-field, not a descendant. Filter on the mat-form-field
              // parent that contains the "Type" label, then locate mat-select inside it.
              const typeFormField = settingsDialog.locator('mat-form-field').filter({
                has: page.locator('mat-label', { hasText: /^Type$/i })
              }).first();
              await typeFormField.waitFor({ state: 'visible', timeout: 8000 });
              const typeSelect = typeFormField.locator('mat-select').first();
              await typeSelect.waitFor({ state: 'visible', timeout: 5000 });
              await selectMatSelectOption(page, typeSelect, type);

              // Text field
              if (text) {
                const textField = settingsDialog.locator('textarea[aria-label="Text"]').first();
                await textField.waitFor({ state: 'visible', timeout: 5000 });
                await fillAngularTextarea(textField, text);
              }

              // Question field (follow-up response)
              if (question) {
                const questionField = settingsDialog.locator('textarea[aria-label="Question"]').first();
                await questionField.waitFor({ state: 'visible', timeout: 5000 });
                await fillAngularTextarea(questionField, question);
              }
            }

            // Buttons -- distinguish + Option from + Child Option by text
            const addOptionBtn = settingsDialog.getByRole('button', { name: /^\+\s*Option$/i }).first()
              .or(settingsDialog.locator('button.mat-raised-button', { hasText: /^\s*Option\s*$/ }).first());
            const addChildBtn  = settingsDialog.getByRole('button', { name: /child option/i }).first();

            // Step 2: Process each top-level option
            const choices = Array.isArray(slide.choices) ? slide.choices : [];
            for (let i = 0; i < choices.length; i++) {
              const choice = choices[i];

              // Skip invalid or empty choices -- guards against Resources table
              // rows leaking in (e.g. type='HTML_text') and blank template rows.
              const validTypes = /^(button|text|link)$/i;
              if (choice.type && !validTypes.test(choice.type)) {
                emitLog(`  Option ${i + 1}: skipped invalid type "${choice.type}"`);
                continue;
              }
              if (!choice.text || !choice.text.trim()) {
                emitLog(`  Option ${i + 1}: skipped empty text`);
                continue;
              }

              // Click + Option -- new row is auto-selected on the right panel
              await addOptionBtn.scrollIntoViewIfNeeded().catch(() => {});
              await addOptionBtn.click();
              await page.waitForTimeout(400);

              // Fill the right-panel fields for this option
              await fillOptionFields(
                choice.type || 'Button',
                choice.text || '',
                choice.question || ''
              );
              emitLog(`  Option ${i + 1}: ${choice.type || 'Button'} — "${(choice.text||'').substring(0,40)}"`);

              // Step 3: Handle child options if present
              if (Array.isArray(choice.children) && choice.children.length > 0) {
                for (const child of choice.children) {
                  await addChildBtn.scrollIntoViewIfNeeded().catch(() => {});
                  await addChildBtn.click();
                  await page.waitForTimeout(400);

                  await fillOptionFields(
                    child.type || 'Text',
                    child.text || '',
                    child.question || ''
                  );
                  emitLog(`    Child: ${child.type || 'Text'} — "${(child.text||'').substring(0,40)}"`);
                }
              }
            }

            const okBtn = settingsDialog.locator('.mat-dialog-actions button.mat-primary', { hasText: 'OK' });
            await okBtn.waitFor({ state: 'visible', timeout: 10000 });
            await okBtn.click();
            await settingsDialog.waitFor({ state: 'hidden', timeout: 15000 });
            await clearOverlays(page);
          }

          // STUDENT POLL SLIDE
          if (slide.slide_type === 'student_poll') {
            // Order matches top-to-bottom layout in LEAP:
            // 1. Chart Title  (input at very top -- formcontrolname="chartTitle")
            // 2. Question body (CKEditor -- source mode paste)
            // 3. Feedback     (textarea below chart title)
            // 4. Choices      (Add Choice rows -- Choice + Chart Label pairs)
            // 5. Scroll to Chart section
            // 6. Set Chart Type (mat-button-toggle: PieChart / BarChart / LineChart)
            // 7. Scroll OK button into view and click it

            // Step 1: Fill Chart Title first -- it's at the top of the dialog
            if (slide.chart_title) {
              const chartTitleField = settingsDialog
                .locator('input[formcontrolname="chartTitle"], input[aria-label="Chart Title"]')
                .first();
              await chartTitleField.waitFor({ state: 'visible', timeout: 8000 });
              await fillAngularTextarea(chartTitleField, slide.chart_title);
              emitLog(`  Chart title: "${slide.chart_title}"`);
            }

            // Step 2: Fill question body via CKEditor source mode
            if (slide.question_body) {
              const ckSourceBtn = settingsDialog.locator('button.ck-source-editing-button').first();
              await ckSourceBtn.waitFor({ state: 'visible', timeout: 10000 });
              await ckSourceBtn.click();
              const ckTextarea = settingsDialog.locator('.ck-source-editing-area textarea').first();
              await ckTextarea.waitFor({ state: 'visible', timeout: 8000 });
              await ckTextarea.fill(slide.question_body);
              await ckSourceBtn.click();
              await page.waitForTimeout(300);
              emitLog(`  Question body: ${slide.question_body.length} chars`);
            }

            // Step 3: Fill Feedback
            if (slide.feedback) {
              const feedbackField = settingsDialog.locator('textarea[aria-label="Feedback"]').first();
              await feedbackField.waitFor({ state: 'visible', timeout: 8000 });
              await fillAngularTextarea(feedbackField, slide.feedback);
            }

            // Step 4: Add choices
            const addChoiceBtn = settingsDialog.getByRole('button', { name: /add choice/i }).first();
            const choices = Array.isArray(slide.choices) ? slide.choices : [];
            for (let i = 0; i < choices.length; i++) {
              const choice = choices[i];
              if (!choice.text || !choice.text.trim()) continue;

              await addChoiceBtn.scrollIntoViewIfNeeded().catch(() => {});
              await addChoiceBtn.click();
              await page.waitForTimeout(400);

              // Fill the nth Choice and Chart Label pair
              const choiceInputs = settingsDialog.locator('textarea[aria-label="Choice"]');
              const labelInputs  = settingsDialog.locator('textarea[aria-label="Chart Label"]');

              const choiceCount = await choiceInputs.count().catch(() => 0);
              if (choiceCount > 0) {
                const choiceField = choiceInputs.nth(choiceCount - 1);
                await choiceField.waitFor({ state: 'visible', timeout: 5000 });
                await fillAngularTextarea(choiceField, choice.text);
              }
              const labelCount = await labelInputs.count().catch(() => 0);
              if (labelCount > 0 && choice.chart_label) {
                const labelField = labelInputs.nth(labelCount - 1);
                await labelField.waitFor({ state: 'visible', timeout: 5000 });
                await fillAngularTextarea(labelField, choice.chart_label || choice.text);
              }
              emitLog(`  Choice ${i + 1}: "${(choice.text||'').substring(0,40)}"`);
            }

            // Step 5: Scroll down to the Chart section
            await settingsDialog.locator('text=Chart').last().scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(300);

            // Step 6: Set chart type
            const chartTypeMap = {
              pie:  'PieChart',
              bar:  'BarChart',
              line: 'LineChart',
            };
            const rawType  = (slide.chart_type || 'pie').toLowerCase().trim();
            const leapType = chartTypeMap[rawType] || 'PieChart';
            const chartToggle = settingsDialog.locator(`mat-button-toggle[value="${leapType}"]`).first();
            if (await chartToggle.count().catch(() => 0)) {
              await chartToggle.scrollIntoViewIfNeeded().catch(() => {});
              await chartToggle.click();
              await page.waitForTimeout(300);
              emitLog(`  Chart type: ${leapType}`);
            }

            // Step 7: Scroll OK into view then click -- ensures it's reachable
            // regardless of where the dialog scroll position ended up
            const okBtn = settingsDialog.locator('.mat-dialog-actions button.mat-primary', { hasText: 'OK' });
            await okBtn.waitFor({ state: 'visible', timeout: 10000 });
            await okBtn.scrollIntoViewIfNeeded().catch(() => {});
            await page.waitForTimeout(200);
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

          const translated = translateError(err, { slideName: slide.slide_name, slideType: slide.slide_type });

          emit({
            type: 'slide_fail',
            lessonTitle,
            slideName: slide.slide_name,
            slideType: slide.slide_type,
            error: err.message,                        // technical -- goes to run log only
            userMessage: translated.userMessage,       // plain language -- shown in GUI
            suggestion: translated.suggestion,         // action to take -- shown in GUI
            screenshotFile: path.basename(screenshotPath),
            htmlFile: path.basename(htmlPath),
          });

          // Run log gets the full technical error for debugging
          appendRunLog({ lessonTitle, slideName: slide.slide_name, slideType: slide.slide_type, status: 'FAIL', error: err.message, userMessage: translated.userMessage });

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

function translateError(err, context) {
  const msg = (err.message || '').toLowerCase();
  const slideName = context.slideName || 'this slide';
  const slideType = context.slideType || '';

  // Slide Settings button never appeared -- type not set or scroll issue
  if (msg.includes('slide settings') || (msg.includes('timeout') && msg.includes('getbyro') && msg.includes('slide settings'))) {
    return {
      userMessage: `LEAP did not show the Slide Settings button for "${slideName}". The slide type may not have been set correctly.`,
      suggestion: 'Delete the blank slide in LEAP then run again from this lesson.'
    };
  }
  // Dropdown option not found or timed out -- likely needs scroll
  if (msg.includes('mat-option') || msg.includes('locator.click') && msg.includes('panel')) {
    return {
      userMessage: `The slide type dropdown could not find or click the option for "${slideType}" on slide "${slideName}".`,
      suggestion: 'This can happen when the option is off-screen in the dropdown. Run again — the scroll fix should handle it automatically.'
    };
  }
  // Save button never enabled
  if (msg.includes('save') && msg.includes('disabled')) {
    return {
      userMessage: `The Save button did not activate for "${slideName}".`,
      suggestion: 'Run again from this lesson — the tool will retry automatically.'
    };
  }
  // Settings dialog would not close -- validation error inside
  if (msg.includes('dialog') && msg.includes('hidden')) {
    return {
      userMessage: `The slide settings dialog did not close for "${slideName}". A required field may be empty or invalid.`,
      suggestion: 'Check that all fields in the JSON for this slide have valid content, then run again.'
    };
  }
  // CKEditor or source textarea not found
  if (msg.includes('ck-source') || msg.includes('source-editing')) {
    return {
      userMessage: `The content editor did not load correctly for "${slideName}".`,
      suggestion: 'Run again from this lesson. If it keeps failing, check that the slide type is set to the correct type in LEAP.'
    };
  }
  // Login / page not ready
  if (msg.includes('locator.fill') && msg.includes('timeout') || msg.includes('login')) {
    return {
      userMessage: 'LEAP was not ready when the tool tried to start.',
      suggestion: 'Run again and make sure you are fully logged in before the tool begins.'
    };
  }
  // Module or file not found
  if (msg.includes('cannot find module') || msg.includes('module_not_found')) {
    return {
      userMessage: 'A required file is missing.',
      suggestion: 'Make sure all files are in the IMPORTER-APP folder and run start.bat again.'
    };
  }
  // Sorting category mismatch
  if (msg.includes('correct_category') || msg.includes('not in categories')) {
    return {
      userMessage: `A sort item in "${slideName}" has a category that does not match any category name exactly.`,
      suggestion: 'Check that every correct_category value in the JSON exactly matches one of the categories[] entries — same spelling and capitalization.'
    };
  }
  // Complete the Story bracket or choice issue
  if (slideType === 'complete_the_story' || msg.includes('placeholder') || msg.includes('choice text')) {
    return {
      userMessage: `Something went wrong filling in the blanks for "${slideName}".`,
      suggestion: 'Make sure the story_body text uses [[double brackets]] around each blank and that every placeholder has a matching answer in placeholders[].'
    };
  }
  // Generic fallback
  return {
    userMessage: `Something went wrong while creating "${slideName}" (${slideType}).`,
    suggestion: 'Check the run log for details and try running again from this lesson.'
  };
}

main().catch(async err => {
  emit({ type: 'fatal', message: err.message });
  process.exit(1);
});
