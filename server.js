const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const archiver = require('archiver');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const RUN_OUTPUTS_DIR = path.join(__dirname, 'run_outputs');
const HISTORY_FILE = path.join(RUN_OUTPUTS_DIR, 'history.json');
const PERSISTENT_LOG_FILE = path.join(RUN_OUTPUTS_DIR, 'persistent_log.jsonl');

// ============================
// Run retention
// ============================
// Keep this many of the most recent run folders on disk; older ones are deleted
// to reclaim space (logs, screenshots, and the output zip add up over time).
// Only the per-run FOLDERS are removed. The slim history entry stays in
// history.json so the run still shows in the UI, and persistent_log.jsonl is
// never touched -- that file holds the cross-run "this slide was already built"
// memory, so resume/dedup keeps working even for runs whose folders were purged.
const KEEP_RECENT_RUNS = 20;

// Files that live directly in run_outputs/ and must never be deleted by cleanup.
const PROTECTED_TOP_LEVEL = new Set(['history.json', 'persistent_log.jsonl']);

// Ensure output directory exists
if (!fs.existsSync(RUN_OUTPUTS_DIR)) fs.mkdirSync(RUN_OUTPUTS_DIR, { recursive: true });

// ============================
// Path safety
// ============================
// Every runId the server generates has the form run_<digits>_<6 hex chars>
// (see POST /api/run/start). Anything that doesn't match is forged input, so we
// reject it before it ever touches the filesystem. This blocks path traversal via
// the runId param: "..", slashes, backslashes, and null bytes all fail this test.
const RUN_ID_RE = /^run_\d+_[0-9a-f]{6}$/;
function isValidRunId(runId) {
  return typeof runId === 'string' && RUN_ID_RE.test(runId);
}

// Artifact filenames are basenames the server itself listed (FAIL_*.png / *.html).
// Restrict to a safe basename: no path separators, no "..", limited charset.
const ARTIFACT_NAME_RE = /^[A-Za-z0-9._-]+\.(png|html)$/;
function isValidArtifactName(name) {
  return typeof name === 'string' && ARTIFACT_NAME_RE.test(name) && !name.includes('..');
}

// Resolve a path inside RUN_OUTPUTS_DIR and verify it cannot escape the base
// directory. Returns the resolved absolute path, or null if it would escape.
// This is a second layer of defense on top of the regex validators above.
function resolveInsideRunOutputs(...parts) {
  const base = path.resolve(RUN_OUTPUTS_DIR);
  const resolved = path.resolve(base, ...parts);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// Active SSE clients per runId
const sseClients = new Map();

// Active automation processes per runId
const activeRuns = new Map();

// ============================
// Middleware
// ============================
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'gui')));

// ============================
// History helpers
// ============================
function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
}

function upsertHistory(run) {
  const history = loadHistory();
  const idx = history.findIndex(r => r.runId === run.runId);
  if (idx >= 0) history[idx] = run;
  else history.unshift(run);
  saveHistory(history);
}

// ============================
// Run-folder cleanup (retention)
// ============================
// Delete all but the KEEP_RECENT_RUNS most recent run folders. "Most recent" is
// determined by folder modification time, which is robust even if history.json
// is missing or out of sync. Never deletes a folder for a run that is currently
// active, and never touches the protected top-level files. Returns a summary.
function cleanupOldRuns() {
  const result = { scanned: 0, deleted: [], kept: 0, errors: [] };
  let entries;
  try {
    entries = fs.readdirSync(RUN_OUTPUTS_DIR, { withFileTypes: true });
  } catch (err) {
    result.errors.push(`Could not read run_outputs: ${err.message}`);
    return result;
  }

  // Only consider directories that look like real run folders.
  const runDirs = entries
    .filter(e => e.isDirectory() && isValidRunId(e.name))
    .map(e => {
      const full = path.join(RUN_OUTPUTS_DIR, e.name);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      return { name: e.name, full, mtime };
    });

  result.scanned = runDirs.length;
  if (runDirs.length <= KEEP_RECENT_RUNS) {
    result.kept = runDirs.length;
    return result;
  }

  // Newest first, then drop everything past the keep threshold.
  runDirs.sort((a, b) => b.mtime - a.mtime);
  const keep = runDirs.slice(0, KEEP_RECENT_RUNS);
  const purge = runDirs.slice(KEEP_RECENT_RUNS);
  result.kept = keep.length;

  for (const dir of purge) {
    // Defense in depth: never delete an active run's folder, never delete a
    // protected file, and never delete anything resolving outside run_outputs.
    if (activeRuns.has(dir.name)) { result.kept++; continue; }
    if (PROTECTED_TOP_LEVEL.has(dir.name)) continue;
    const safe = resolveInsideRunOutputs(dir.name);
    if (!safe || safe === path.resolve(RUN_OUTPUTS_DIR)) {
      result.errors.push(`Refused to delete suspicious path: ${dir.name}`);
      continue;
    }
    try {
      fs.rmSync(safe, { recursive: true, force: true });
      result.deleted.push(dir.name);
    } catch (err) {
      result.errors.push(`Failed to delete ${dir.name}: ${err.message}`);
    }
  }
  return result;
}

// ============================
// SSE broadcast helper
// ============================
function broadcast(runId, event, data) {
  const clients = sseClients.get(runId) || [];
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch {}
  });
}

// ============================
// GET /api/history
// ============================
app.get('/api/history', (req, res) => {
  res.json(loadHistory());
});

// ============================
// DELETE /api/history/:runId
// ============================
app.delete('/api/history/:runId', (req, res) => {
  const { runId } = req.params;
  if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid run id' });
  const history = loadHistory();
  const updated = history.filter(r => r.runId !== runId);
  if (updated.length === history.length) return res.status(404).json({ error: 'Run not found' });
  saveHistory(updated);
  res.json({ ok: true, deleted: runId });
});

// ============================
// GET /api/run/:runId/log
// ============================
app.get('/api/run/:runId/log', (req, res) => {
  if (!isValidRunId(req.params.runId)) return res.status(400).json({ error: 'Invalid run id' });
  const logPath = resolveInsideRunOutputs(req.params.runId, 'run.log');
  if (!logPath || !fs.existsSync(logPath)) return res.status(404).json({ error: 'Log not found' });
  res.type('text/plain').send(fs.readFileSync(logPath, 'utf8'));
});

// ============================
// GET /api/run/:runId/download
// ============================
app.get('/api/run/:runId/download', (req, res) => {
  if (!isValidRunId(req.params.runId)) return res.status(400).json({ error: 'Invalid run id' });
  const zipPath = resolveInsideRunOutputs(req.params.runId, 'output.zip');
  if (!zipPath || !fs.existsSync(zipPath)) return res.status(404).json({ error: 'Archive not found yet' });
  res.download(zipPath, `leap-run-${req.params.runId}.zip`);
});

// ============================
// GET /api/run/:runId/artifacts
// List screenshots and html captures for a run
// ============================
app.get('/api/run/:runId/artifacts', (req, res) => {
  if (!isValidRunId(req.params.runId)) return res.status(400).json({ error: 'Invalid run id' });
  const runDir = resolveInsideRunOutputs(req.params.runId);
  if (!runDir || !fs.existsSync(runDir)) return res.json([]);
  const files = fs.readdirSync(runDir)
    .filter(f => f.endsWith('.png') || f.endsWith('.html'))
    .map(f => ({ name: f, url: `/api/run/${req.params.runId}/artifact/${f}` }));
  res.json(files);
});

app.get('/api/run/:runId/artifact/:filename', (req, res) => {
  if (!isValidRunId(req.params.runId)) return res.status(400).send('Invalid run id');
  if (!isValidArtifactName(req.params.filename)) return res.status(400).send('Invalid filename');
  const filePath = resolveInsideRunOutputs(req.params.runId, req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// ============================
// GET /api/run/:runId/events  (SSE)
// ============================
app.get('/api/run/:runId/events', (req, res) => {
  const { runId } = req.params;
  if (!isValidRunId(runId)) return res.status(400).json({ error: 'Invalid run id' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients.has(runId)) sseClients.set(runId, []);
  sseClients.get(runId).push(res);

  // Send current log so reconnecting clients catch up
  const logPath = resolveInsideRunOutputs(runId, 'run.log');
  if (logPath && fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    lines.forEach(line => {
      try {
        const entry = JSON.parse(line);
        res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
      } catch {}
    });
  }

  req.on('close', () => {
    const clients = sseClients.get(runId) || [];
    sseClients.set(runId, clients.filter(c => c !== res));
  });
});

// ============================
// POST /api/run/start
// Body: { courseJson, startFromLesson, runMode }
// ============================
app.post('/api/run/start', (req, res) => {
  const { courseJson, startFromLesson, runMode } = req.body;

  if (!courseJson) return res.status(400).json({ error: 'courseJson is required' });

  const runId = `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const runDir = path.join(RUN_OUTPUTS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // Write input JSON to run directory
  const inputPath = path.join(runDir, 'input.json');
  fs.writeFileSync(inputPath, JSON.stringify(courseJson, null, 2), 'utf8');

  const logPath = path.join(runDir, 'run.log');
  const runLogPath = path.join(runDir, 'slides.jsonl');
  const persistentLogPath = path.join(RUN_OUTPUTS_DIR, 'persistent_log.jsonl');

  // Parse course name for display
  const courseName = courseJson?.course?.title || 'Unknown Course';
  const totalLessons = courseJson?.course?.units?.reduce((a, u) => a + (u.lessons?.length || 0), 0) || 0;
  const totalSlides = courseJson?.course?.units?.reduce((a, u) =>
    a + u.lessons?.reduce((b, l) => b + (l.slides?.length || 0), 0), 0) || 0;

  const runMeta = {
    runId,
    courseName,
    startFromLesson: startFromLesson || null,
    runMode: runMode || 'normal',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalLessons,
    totalSlides,
    completedSlides: 0,
    failedSlides: 0,
  };

  upsertHistory(runMeta);
  res.json({ runId, courseName, totalLessons, totalSlides });

  // Write initial log entry
  const appendLog = (entry) => {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
    broadcast(runId, 'log', entry);
  };

  appendLog({ type: 'run_start', runId, courseName, totalLessons, totalSlides, ts: new Date().toISOString() });

  // Spawn automation process
  const automationArgs = [
    path.join(__dirname, 'automation.js'),
    '--runId', runId,
    '--runDir', runDir,
    '--inputJson', inputPath,
    '--runLogPath', runLogPath,
  ];

  automationArgs.push('--persistentLog', persistentLogPath);
  if (startFromLesson) automationArgs.push('--startFrom', startFromLesson);
  if (runMode === 'rebuild') automationArgs.push('--forceRebuild');

  const child = spawn(process.execPath, automationArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  activeRuns.set(runId, child);

  // Watchdog: if the automation hangs (e.g. the login window expires in an odd
  // state, or LEAP stops responding), kill it after a maximum duration so it
  // doesn't sit in activeRuns forever holding resources. The timer is cleared
  // when the process closes normally.
  const RUN_MAX_MS = 2 * 60 * 60 * 1000; // 2 hours
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    if (activeRuns.has(runId)) {
      watchdogFired = true;
      appendLog({ type: 'error', message: `Run exceeded ${RUN_MAX_MS / 60000} min limit -- terminating (possible hang).`, ts: new Date().toISOString() });
      try { child.kill('SIGTERM'); } catch {}
      // Hard-kill if it ignores SIGTERM.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000);
    }
  }, RUN_MAX_MS);

  // Process one line of automation stdout into a structured log event.
  const processStdoutLine = (line) => {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = { type: 'raw', message: line.trim(), ts: new Date().toISOString() };
    }
    appendLog(entry);

    // Update run meta counters
    if (entry.type === 'slide_success') {
      runMeta.completedSlides++;
      upsertHistory({ ...runMeta });
    } else if (entry.type === 'slide_fail') {
      runMeta.failedSlides++;
      upsertHistory({ ...runMeta });
    }
  };

  // Stream stdout lines as structured log events
  let stdoutBuffer = '';
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
    lines.forEach(processStdoutLine);
  });

  child.stderr.on('data', chunk => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    lines.forEach(line => appendLog({ type: 'error', message: line.trim(), ts: new Date().toISOString() }));
  });

  child.on('close', async (code) => {
    activeRuns.delete(runId);
    clearTimeout(watchdog);

    // Flush any final stdout line that arrived without a trailing newline
    // (e.g. if the process died mid-line) so the last log entry isn't lost.
    if (stdoutBuffer.trim()) {
      processStdoutLine(stdoutBuffer);
      stdoutBuffer = '';
    }

    const status = watchdogFired ? 'failed' : (code === 0 ? 'completed' : 'failed');
    runMeta.status = status;
    if (watchdogFired) runMeta.timedOut = true;
    runMeta.finishedAt = new Date().toISOString();
    upsertHistory({ ...runMeta });

    appendLog({ type: 'run_end', status, exitCode: code, timedOut: watchdogFired, ts: new Date().toISOString() });

    // Create zip archive
    try {
      const zipPath = path.join(runDir, 'output.zip');
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        archive.glob('**/*', { cwd: runDir, ignore: ['output.zip'] });
        archive.finalize();
      });
      appendLog({ type: 'archive_ready', zipPath, ts: new Date().toISOString() });
    } catch (err) {
      appendLog({ type: 'error', message: `Failed to create archive: ${err.message}`, ts: new Date().toISOString() });
    }

    broadcast(runId, 'run_end', { status, exitCode: code });

    // Reclaim disk: keep only the most recent run folders. Runs after every
    // finished import so the folder count stays bounded without manual deletion.
    try {
      const cleaned = cleanupOldRuns();
      if (cleaned.deleted.length) {
        appendLog({ type: 'cleanup', deleted: cleaned.deleted.length, kept: cleaned.kept, ts: new Date().toISOString() });
        console.log(`Cleanup: removed ${cleaned.deleted.length} old run folder(s), kept ${cleaned.kept}.`);
      }
      if (cleaned.errors.length) cleaned.errors.forEach(e => console.warn('Cleanup warning:', e));
    } catch (err) {
      console.warn('Cleanup failed:', err.message);
    }
  });
});

// ============================
// POST /api/run/:runId/cancel
// ============================
app.post('/api/run/:runId/cancel', (req, res) => {
  const child = activeRuns.get(req.params.runId);
  if (!child) return res.status(404).json({ error: 'No active run' });
  child.kill('SIGTERM');
  activeRuns.delete(req.params.runId);
  res.json({ ok: true });
});

// ============================
// POST /api/maintenance/cleanup
// Manually trigger run-folder cleanup and report what was removed.
// ============================
app.post('/api/maintenance/cleanup', (req, res) => {
  try {
    const result = cleanupOldRuns();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================
// Unknown API routes -> 404 JSON
// Without this, the SPA catch-all below would return index.html (HTTP 200) for a
// mistyped or removed /api/... path, which silently masks bugs and is confusing
// to debug. Anything under /api that wasn't matched above is a real 404.
// ============================
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ============================
// Serve GUI for all other (non-API) routes
// ============================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'gui', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`LEAP Importer running at http://localhost:${PORT}`);
  // Reclaim disk on startup in case runs accumulated while the server was down.
  try {
    const cleaned = cleanupOldRuns();
    if (cleaned.deleted.length) {
      console.log(`Startup cleanup: removed ${cleaned.deleted.length} old run folder(s), kept ${cleaned.kept}.`);
    } else {
      console.log(`Startup cleanup: ${cleaned.scanned} run folder(s), nothing to remove (keeping up to ${KEEP_RECENT_RUNS}).`);
    }
    if (cleaned.errors.length) cleaned.errors.forEach(e => console.warn('Cleanup warning:', e));
  } catch (err) {
    console.warn('Startup cleanup failed:', err.message);
  }
});
