@echo off
cd /d C:\Users\Administrator\Documents\yuanta_sync
git add invest_diary.html index.html app.js styles.css run_login.bat yuanta_config_server.py yuanta_sync.py yuanta_sync_guard.py yuanta_login_playwright.py yuanta_dividend_fetch.py yuanta_dividend_sync.py
git diff --cached --quiet && (echo [git] 無變更，略過) || (git commit -m "auto: %date% %time%" && git push origin main && echo [git] 已推送至 GitHub)
