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

// Ensure output directory exists
if (!fs.existsSync(RUN_OUTPUTS_DIR)) fs.mkdirSync(RUN_OUTPUTS_DIR, { recursive: true });

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
  const logPath = path.join(RUN_OUTPUTS_DIR, req.params.runId, 'run.log');
  if (!fs.existsSync(logPath)) return res.status(404).json({ error: 'Log not found' });
  res.type('text/plain').send(fs.readFileSync(logPath, 'utf8'));
});

// ============================
// GET /api/run/:runId/download
// ============================
app.get('/api/run/:runId/download', (req, res) => {
  const zipPath = path.join(RUN_OUTPUTS_DIR, req.params.runId, 'output.zip');
  if (!fs.existsSync(zipPath)) return res.status(404).json({ error: 'Archive not found yet' });
  res.download(zipPath, `leap-run-${req.params.runId}.zip`);
});

// ============================
// GET /api/run/:runId/artifacts
// List screenshots and html captures for a run
// ============================
app.get('/api/run/:runId/artifacts', (req, res) => {
  const runDir = path.join(RUN_OUTPUTS_DIR, req.params.runId);
  if (!fs.existsSync(runDir)) return res.json([]);
  const files = fs.readdirSync(runDir)
    .filter(f => f.endsWith('.png') || f.endsWith('.html'))
    .map(f => ({ name: f, url: `/api/run/${req.params.runId}/artifact/${f}` }));
  res.json(files);
});

app.get('/api/run/:runId/artifact/:filename', (req, res) => {
  const filePath = path.join(RUN_OUTPUTS_DIR, req.params.runId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// ============================
// GET /api/run/:runId/events  (SSE)
// ============================
app.get('/api/run/:runId/events', (req, res) => {
  const { runId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients.has(runId)) sseClients.set(runId, []);
  sseClients.get(runId).push(res);

  // Send current log so reconnecting clients catch up
  const logPath = path.join(RUN_OUTPUTS_DIR, runId, 'run.log');
  if (fs.existsSync(logPath)) {
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

  // Stream stdout lines as structured log events
  let stdoutBuffer = '';
  child.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
    lines.forEach(line => {
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
    });
  });

  child.stderr.on('data', chunk => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    lines.forEach(line => appendLog({ type: 'error', message: line.trim(), ts: new Date().toISOString() }));
  });

  child.on('close', async (code) => {
    activeRuns.delete(runId);

    const status = code === 0 ? 'completed' : 'failed';
    runMeta.status = status;
    runMeta.finishedAt = new Date().toISOString();
    upsertHistory({ ...runMeta });

    appendLog({ type: 'run_end', status, exitCode: code, ts: new Date().toISOString() });

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
// Serve GUI for all other routes
// ============================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'gui', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`LEAP Importer running at http://localhost:${PORT}`);
});
