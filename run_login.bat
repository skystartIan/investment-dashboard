@echo off
:: 排程用：非 headless 執行 Playwright 自動登入 + 下載
set PYTHONIOENCODING=utf-8
set YUANTA_HEADLESS=0

:: 把目前 session 轉到 console，確保 ServiSign 在 Active 狀態下能正常運作
powershell -command "$s = (query session | Select-String 'Administrator' | ForEach-Object { ($_ -split '\s+') | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1 }); if ($s) { Write-Host '[run_login] tscon' $s '/dest:console'; tscon $s /dest:console }"
timeout /t 3 /nobreak >nul

:: log 路徑
for /f "tokens=1-3 delims=/" %%a in ("%date%") do set TODAY=%%a-%%b-%%c
set LOGFILE=C:\Users\Administrator\Documents\yuanta_sync\logs\yuanta_login_%TODAY%.log

"C:\Python311-arm64\python.exe" "C:\Users\Administrator\Documents\yuanta_sync\yuanta_login_playwright.py" >> "%LOGFILE%" 2>&1
