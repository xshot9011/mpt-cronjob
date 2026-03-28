#!/bin/bash

# This script prepares the structure for a Python Lambda Layer.
# Note: To ensure compatibility with Lambda (Linux), it's recommended to 
# run this inside a Docker container or use --platform tags with pip.

set -e

LAYER_DIR_LIB="layer_lib/python"
LAYER_DIR_DRIVER="layer_driver/bin"
LAYER_DIR_BIN="layer_bin/bin"

# Artifact name setting
ZIP_LIB="web-scraper-python-lib-layer.zip"
ZIP_DRIVER="web-scraper-chrome-driver-layer.zip"
ZIP_BIN="web-scraper-chrome-bin-layer.zip"
CODE_ZIP="web-scraper-function.zip"

CHROME_DRIVER="driver/driver-147-0-7727-24"
CHROME_DIR="headless/chrome-headless-shell-mac-arm64"

echo "Cleaning up old layers and zips..."
rm -rf layer_lib layer_driver layer_bin
rm -f "$ZIP_LIB" "$ZIP_DRIVER" "$ZIP_BIN" "$CODE_ZIP"

# --- 1. Python Component Layer ---
echo "Creating library layer structure..."
mkdir -p "$LAYER_DIR_LIB"
pip3 install \
    --target "$LAYER_DIR_LIB" \
    --platform manylinux2014_aarch64 \
    --python-version 3.13 \
    --only-binary=:all: \
    -r requirements.txt

echo "Zipping library layer..."
cd layer_lib && zip -rq "../$ZIP_LIB" . && cd ..

# --- 2. Driver Component Layer ---
echo "Creating driver layer structure..."
mkdir -p "$LAYER_DIR_DRIVER"
if [ -f "$CHROME_DRIVER" ]; then
    cp "$CHROME_DRIVER" "$LAYER_DIR_DRIVER/chromedriver"
    chmod +x "$LAYER_DIR_DRIVER/chromedriver"
    echo "Zipping driver layer..."
    cd layer_driver && zip -rq "../$ZIP_DRIVER" . && cd ..
else
    echo "Warning: $CHROME_DRIVER not found. Skipping driver layer."
fi

# --- 3. Browser Binaries Layer ---
echo "Creating browser binary layer structure..."
mkdir -p "$LAYER_DIR_BIN"
if [ -d "$CHROME_DIR" ]; then
    cp -r "$CHROME_DIR" "$LAYER_DIR_BIN/headless-chromium"
    chmod +x "$LAYER_DIR_BIN/headless-chromium/chrome-headless-shell"
    echo "Zipping browser binary layer..."
    cd layer_bin && zip -rq "../$ZIP_BIN" . && cd ..
else
    echo "Warning: $CHROME_DIR directory not found. Skipping bin layer."
fi

# --- 4. Lambda Function Code ---
echo "Zipping Lambda function code..."
zip -q "$CODE_ZIP" lambda_function.py scraper.py config.json

echo "Done! Generated packages:"
ls -lh "$ZIP_LIB" "$ZIP_DRIVER" "$ZIP_BIN" "$CODE_ZIP" 2>/dev/null || true
echo "Note: Upload these layers individually to AWS Lambda and attach them to your function."

