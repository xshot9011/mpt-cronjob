# mpt-cronjob

A Python scraper script designed to be run as a macOS `launchd` cron job every day at 1 PM. Uses Selenium with headless Chrome to handle JavaScript-rendered pages.

## Prerequisites

- **Google Chrome** must be installed.
- **ChromeDriver** binary placed in this project folder (or update the path in `config.json`).

## Setup

### 1. Create a Virtual Environment
```bash
python3 -m venv venv
```

### 2. Activate and Install Dependencies
Activate the virtual environment and install the required libraries using `pip3`:
```bash
source venv/bin/activate
pip3 install -r requirements.txt
```

### 3. Configure Scraping Targets
Edit `config.json` to define your scraping steps. You can specify a sequence of `actions` (e.g., `click` then `get`):
```json
{
    "chrome_driver_path": null,
    "headless": true,
    "wait_timeout": 10,
    "action_wait": 2,
    "targets": [
        {
            "name": "PF&REIT TRI",
            "url": "https://www.set.or.th/th/market/index/tri/overview",
            "actions": [
                { "type": "click", "xpath": "//span[contains(text(), 'PROPCON TRI')]" },
                { "type": "get", "xpath": "//tr[td[contains(., 'PF&REIT TRI')]]/td[2]" }
            ]
        }
    ]
}
```

### 4. Run the Scraper Manually
Verify the script works:
```bash
./venv/bin/python3 scraper.py
```

### 5. Schedule with launchd (macOS)
Use the helper script to generate the `.plist` file with the correct absolute paths for your environment:

```bash
python3 setup_cron.py --hour 13 --minute 0
```

Then copy and load the agent:
```bash
cp com.user.mpt-cronjob.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.user.mpt-cronjob.plist
```
> [!NOTE]
> If your computer is shut down at the scheduled time, macOS will automatically run the job as soon as it starts up or wakes up.

## Logs
- `scraper_run.log`: Application logs with INFO and ERROR levels.
- `stdout.log`: Standard output from launchd.
- `stderr.log`: Error output from launchd.
