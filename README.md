# LEAP Course Importer

A local tool for importing course content into the LEAP LMS.
No technical knowledge required to use it.

---

## First-Time Setup

### 1. Install Node.js
Download and install Node.js from https://nodejs.org
Choose the **LTS** version (recommended).

### 2. Start the tool

**Windows:** Double-click `start.bat`

**Mac / Linux:** Open Terminal, navigate to this folder, run:
```
bash start.sh
```

The first time you run it, it will automatically install all required
dependencies and the Chromium browser. This takes 1-2 minutes.
After that, it opens automatically at http://localhost:3000

---

## How to Use

1. **Load your course file** — drag and drop your `.json` course package
   onto the file picker, or click to browse.

2. **Set a start lesson** *(optional)* — if you want to resume from a
   specific lesson rather than starting from the beginning, type the
   exact lesson title in the "Start From Lesson" field.

3. **Choose a run mode:**
   - **Normal** — skips slides that were already completed in a previous run
   - **Rebuild** — recreates all slides from scratch

4. **Click Start Import** — a browser window will open showing the LEAP
   login page.

5. **Log in to LEAP** — use your normal credentials in the browser window
   that opened. Then come back to the importer and click
   **"I've Logged In — Continue"**.

6. **Watch the progress** — the center panel shows live activity as each
   lesson and slide is created.

7. **When it finishes** — a green banner confirms success. Use the
   Run History panel on the right to download a full archive of the run,
   view logs, or inspect any failure screenshots.

---

## Run History

Every run is saved automatically. From the history panel you can:
- **View Log** — see a full timestamped log of everything that happened
- **Artifacts** — view screenshots and HTML captures from any failures
- **Download** — get a zip archive of the entire run for sharing or archiving
- **Resume** — click Resume on a failed run to pre-fill the start lesson

---

## Troubleshooting

**The browser opened but nothing is happening**
Make sure you clicked "I've Logged In — Continue" after logging in to LEAP.

**A slide failed**
Check the Artifacts for that run — a screenshot shows exactly what the
page looked like when the error occurred. Use "Start From Lesson" to
resume from where it stopped.

**Node.js not found error**
Install Node.js from https://nodejs.org and try again.

**Port 3000 already in use**
Open `server.js` in a text editor and change `const PORT = 3000` to
another number (e.g. 3001), then restart.
