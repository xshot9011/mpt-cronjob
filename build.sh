#!/bin/bash

# This script prepares the structure for a Python Lambda Layer.
# Note: To ensure compatibility with Lambda (Linux), it's recommended to 
# run this inside a Docker container or use --platform tags with pip.

set -e

LAYER_DIR="layer/python"
ZIP_FILE="web-scraper-layer.zip"
CODE_ZIP="web-scraper-function.zip"

echo "Cleaning up old layer..."
rm -rf layer
rm -f "$ZIP_FILE"

echo "Creating layer directory structure..."
mkdir -p "$LAYER_DIR"

echo "Installing dependencies from requirements.txt..."
# Use --platform to ensure Linux compatibility if running on Mac
# Note: This requires a modern version of pip
    # --implementation py \
pip3 install \
    --target "$LAYER_DIR" \
    --platform manylinux2014_aarch64 \
    --python-version 3.13 \
    --only-binary=:all: \
    -r requirements.txt

echo "Zipping the layer..."
cd layer
zip -r "../$ZIP_FILE" .
cd ..

echo "Cleaning up old code zip..."
rm -f "$CODE_ZIP"

echo "Zipping the Lambda function code..."
zip "$CODE_ZIP" lambda_function.py scraper.py config.json driver/driver-147-0-7727-24

echo "Done! Layer package created as $ZIP_FILE"
echo "Done! Lambda code package created as $CODE_ZIP"
echo "Note: This layer only contains Python libraries. You still need the Chrome/ChromeDriver binaries in your Lambda environment (e.g., in /opt/bin/)."
