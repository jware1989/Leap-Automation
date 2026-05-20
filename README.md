# LEAP Course Importer

A tool that automatically builds course content inside the LEAP learning management system. Instead of copying and pasting each slide by hand, you load your course file and the tool will add the slides and content in a new Chrome browser.

**Important**
Do Not click inside the virtual Chrome browser while the tool is running, it's safe to minimize or drag the window around. Clicking inside the browser will stop the import, if this happens just run import again and it will pick up where last left off.

---

## Before You Start

You only need to do this once.

**1. Install Node.js**
Node.js is a free program that runs this tool. Download it from [https://nodejs.org](https://nodejs.org) and install it the same way you would install any program. Choose the version labeled **LTS** — that is the recommended one.

**2. Create your lessons in LEAP first**
The importer fills in the content of your lessons but it cannot create the lessons themselves. Before running the tool, log in to LEAP and manually create every lesson for the course you are building. The lesson names in LEAP must match the lesson names in your course file exactly, including capitalization and punctuation.

---

## Starting the Tool

**Windows:** Find the IMPORTER-APP folder on your computer and double-click the file named **start.bat**.

**Mac:** Open the Terminal app, type `bash ` (with a space after it), then drag the **start.sh** file from the IMPORTER-APP folder into the Terminal window and press Enter.

The first time you run it, the tool will spend about 1 to 2 minutes downloading a few things it needs. After that it opens automatically, if it doesn't just go to http://localhost:3000/

> **Important:** A black terminal window will appear when you start the tool. Do not close it while you are using the importer. That window is what keeps the tool running. You can minimize it and leave it in the background.

---

## How to Use It

The importer has three panels. Here is what each one does before you begin:

| Panel | Location | Purpose |
|---|---|---|
| **Configuration** | Left side | Where you load your file, choose your starting lesson, and pick your run mode |
| **Live Progress** | Center | Shows each slide being created in real time once a run starts |
| **Run History** | Right side | A record of every run you have done, with options to view logs or download results |

### Step 1a — Load your course file

In the **Configuration** panel, drag your course file onto the upload area, or click it to browse for the file. The tool accepts two file types:

- **.docx** — a Word storyboard document (the tool converts it automatically)
- **.json** — a pre-built course package (usually for testing)

Once the file loads, the **Start From Lesson** dropdown will fill in with all the lessons from your file.

> If you uploaded a storyboard, check the flag count that appears after it converts. A flag means the tool found something it could not read cleanly. The import could potentially skip these slides if flagged items aren't addressed.

### Step 1b — Choose a starting lesson (optional)

Leave the **Start From Lesson** dropdown set to **All lessons from the beginning** for a normal full run.

If you are picking up where a previous run stopped, select the lesson you want to start from.

### Step 3 — Choose a run mode

| Mode | When to use it |
|---|---|
| **Normal** | Use this for standard runs and for resuming after a stop. The tool remembers what was already completed and skips those slides, so you never do the same work twice. |
| **Rebuild** | Use this only when you need to redo slides that already exist in LEAP. It starts everything from scratch, which takes just as long as a first run. |

### Step 4 — Start the import

Click **Start Import**. A browser window running LEAP will appear on your screen — this is the tool doing its work. Do not click inside it or interact with LEAP while the run is in progress.

Each slide takes roughly 5 to 15 seconds to create. A course with around 100 slides typically completes in 90 to 120 minutes.

### Step 5 — Review your results

When the run finishes, the **Run History** panel will show whether it completed successfully or encountered errors.

- Click **View Log** to see a record of every slide that was processed
- Click **Artifacts** to download a file containing any error screenshots taken during the run
- Click **Download** to save a full archive of the run
- Click **Delete** to remove a run entry from the history list

After every run, log in to LEAP and spot-check a sample of slides before sharing the course with anyone.

---

## If Something Goes Wrong

**The browser opened but nothing is happening**
Make sure the LEAP browser window is on your screen, not minimized. The tool needs that window to stay open and visible while it works.

**A slide failed or came out blank**
Open the Artifacts for that run to see a screenshot of what happened. Delete the problem slide from LEAP manually, then run the importer again in Normal mode. It will skip everything already completed and only redo the slide that failed.

**The run stopped partway through**
Use the **Start From Lesson** dropdown to pick up from the lesson where it stopped. Run in Normal mode — completed slides will be skipped automatically.

**Flags appeared after uploading my storyboard**
A flag means the tool found a formatting issue in that slide. Common causes are a slide heading that uses the wrong text style in Word, a missing answer choice label, or a question with no correct answer marked. Review the flagged slides before starting the import and fix the issue in your storyboard, then re-upload.

**"Node.js not found" error**
Node.js is not installed on your computer. Download and install it from [https://nodejs.org](https://nodejs.org), then try running the tool again.

**Port 3000 already in use**
Another program on your computer is using the same connection the tool needs. Open the file named `server.js` in a plain text editor, find the line that says `const PORT = 3000`, and change `3000` to another number such as `3001`. Save the file and restart the tool.

---

## Run Modes — Quick Reference

| | Normal | Rebuild |
|---|---|---|
| Skips completed slides | Yes | No |
| Time to complete | Faster on re-runs | Same as a first run |
| Use when | Standard run or resuming | Correcting slides that already exist in LEAP |
