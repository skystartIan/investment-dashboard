@echo off
cd /d C:\Users\Administrator\Documents\yuanta_sync
git add invest_diary.html index.html app.js styles.css run_login.bat yuanta_config_server.py yuanta_sync.py yuanta_sync_guard.py yuanta_login_playwright.py yuanta_dividend_fetch.py yuanta_dividend_sync.py yuanta_web_dca.py yuanta_unrealized.py cleanup_downloads.py yuanta_task_watchdog.py check_yuanta_tasks.ps1 yuanta_prices_backfill.py IB/apps-script-core.js IB/fetch_Yahoo.jst
git diff --cached --quiet && (echo [git] 無新變更) || (git commit -m "auto: %date% %time%" && echo [git] 已建立 commit)
rem 無論有沒有新 commit，都把尚未推送的 commit 推上去（例如已在別處 commit 過的）
git push origin main && echo [git] 已推送至 GitHub
