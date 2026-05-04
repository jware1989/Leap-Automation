#!/bin/bash
echo "Starting LEAP Course Importer..."
echo ""

if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed."
    echo "Please download and install Node.js from https://nodejs.org"
    echo "Then run this file again."
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies for the first time..."
    npm install
    if [ $? -ne 0 ]; then
        echo "ERROR: Failed to install dependencies."
        exit 1
    fi
    echo "Installing Chromium browser..."
    npx playwright install chromium
    echo ""
    echo "Setup complete!"
    echo ""
fi

echo "Opening LEAP Importer at http://localhost:3000"
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:3000"
else
    xdg-open "http://localhost:3000" 2>/dev/null || true
fi

node server.js
