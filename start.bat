@echo off
:: Change to the directory where this bat file lives so all paths resolve correctly
cd /d "%~dp0"
echo Starting LEAP Course Importer...
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed.
    echo Please download and install Node.js from https://nodejs.org
    echo Then run this file again.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Installing dependencies for the first time...
    call npm install
    if %errorlevel% neq 0 (
        echo ERROR: Failed to install dependencies.
        pause
        exit /b 1
    )
    echo Installing Chromium browser...
    call npx playwright install chromium
    echo.
    echo Setup complete!
    echo.
)

echo Opening LEAP Importer at http://localhost:3000
start "" "http://localhost:3000"
node server.js
pause
