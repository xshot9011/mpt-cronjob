import os
import sys

# Configuration
PLIST_FILE = "com.user.mpt-cronjob.plist"
SCRAPER_SCRIPT = "scraper.py"
VENV_PYTHON = "venv/bin/python3"

def generate_plist(hour=13, minute=0):
    cwd = os.getcwd()
    python_path = os.path.join(cwd, VENV_PYTHON)
    script_path = os.path.join(cwd, SCRAPER_SCRIPT)
    
    if not os.path.exists(python_path):
        print(f"Error: Virtual environment not found at {python_path}")
        print("Please make sure you have created a venv in this directory.")
        return

    plist_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.mpt-cronjob</string>
    <key>ProgramArguments</key>
    <array>
        <string>{python_path}</string>
        <string>{script_path}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{cwd}</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>{hour}</integer>
        <key>Minute</key>
        <integer>{minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>{cwd}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{cwd}/stderr.log</string>
</dict>
</plist>
"""
    
    with open(PLIST_FILE, "w") as f:
        f.write(plist_content)
    
    print(f"Successfully generated {PLIST_FILE}")
    print("\nTo install the cronjob, run:")
    print(f"cp {PLIST_FILE} ~/Library/LaunchAgents/")
    print(f"launchctl load ~/Library/LaunchAgents/{PLIST_FILE}")
    print("\nTo unload it later:")
    print(f"launchctl unload ~/Library/LaunchAgents/{PLIST_FILE}")
    print(f"rm ~/Library/LaunchAgents/{PLIST_FILE}")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Generate macOS launchd .plist for mpt-cronjob")
    parser.add_argument("--hour", type=int, default=13, help="Hour to run (0-23, default 13)")
    parser.add_argument("--minute", type=int, default=0, help="Minute to run (0-59, default 0)")
    
    args = parser.parse_args()
    generate_plist(args.hour, args.minute)
