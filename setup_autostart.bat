@echo off
:: 建立所有 Windows 工作排程
:: 請用系統管理員身份執行此腳本

set PYTHON=C:\Users\Administrator\AppData\Local\Programs\Python\Python311-arm64\python.exe
set PYTHONW=C:\Users\Administrator\AppData\Local\Programs\Python\Python311-arm64\pythonw.exe
set PYTHON32=C:\Python311-32\python.exe
set SYNC_DIR=C:\Users\Administrator\Documents\yuanta_sync
set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
set LOGIN_URL=https://global.yuanta.com.tw/nexuswebtrade/login/otplogin?returnurl=NexusWebTrade%%2FAnnounce
set WORKDO_URL=https://www.workdo.co/Login?userLang=zh_TW

echo ========================================
echo 建立所有工作排程...
echo ========================================

:: 1. config server 開機自動啟動（pythonw.exe 無視窗）
schtasks /create /tn "YuantaConfigServer" /tr "\"%PYTHONW%\" \"%SYNC_DIR%\yuanta_config_server.py\" --fg" /sc onlogon /ru Administrator /rl highest /f
if %errorlevel% == 0 (echo [OK] YuantaConfigServer - 開機啟動) else (echo [FAIL] YuantaConfigServer)

:: 2. yuanta_sync.py 週一至週五 14:45
schtasks /create /tn "YuantaSync" /tr "\"%PYTHON32%\" \"%SYNC_DIR%\yuanta_sync.py\"" /sc weekly /d MON,TUE,WED,THU,FRI /st 14:45 /ru Administrator /rl highest /f
if %errorlevel% == 0 (echo [OK] YuantaSync - 週一至週五 14:45) else (echo [FAIL] YuantaSync)

:: 3. 清除舊下載檔案 週一至週五 14:49
schtasks /create /tn "YuantaCleanup" /tr "\"%PYTHON%\" \"%SYNC_DIR%\cleanup_downloads.py\"" /sc weekly /d MON,TUE,WED,THU,FRI /st 14:49 /ru Administrator /rl highest /f
if %errorlevel% == 0 (echo [OK] YuantaCleanup - 週一至週五 14:49) else (echo [FAIL] YuantaCleanup)

:: 4. 開啟元大登入頁 週一至週五 14:50
schtasks /create /tn "YuantaOpenBrowser" /tr "\"%CHROME%\" \"%LOGIN_URL%\"" /sc weekly /d MON,TUE,WED,THU,FRI /st 14:50 /ru Administrator /rl highest /f
if %errorlevel% == 0 (echo [OK] YuantaOpenBrowser - 週一至週五 14:50) else (echo [FAIL] YuantaOpenBrowser)

:: 5. yuanta_unrealized.py 週一至週五 15:00
schtasks /create /tn "YuantaUnrealized" /tr "\"%PYTHON%\" \"%SYNC_DIR%\yuanta_unrealized.py\"" /sc weekly /d MON,TUE,WED,THU,FRI /st 15:00 /ru Administrator /rl highest /f
if %errorlevel% == 0 (echo [OK] YuantaUnrealized - 週一至週五 15:00) else (echo [FAIL] YuantaUnrealized)

:: 6. yuanta_web_dca.py 週一至週五 15:05 (腳本內判斷8-12號)
schtasks /create /tn "YuantaDCA" /tr "\"%PYTHON%\" \"%SYNC_DIR%\yuanta_web_dca.py\"" /sc weekly /d MON,TUE,WED,THU,FRI /st 15:05 /ru Administrator /rl highest /f
if %errorlevel% == 0 (echo [OK] YuantaDCA - 週一至週五 15:05 ^(8-12號才執行^)) else (echo [FAIL] YuantaDCA)

:: 7. WorkDo 早上打卡提醒 週一至週五 08:50
schtasks /create /tn "WorkDoMorning" /tr "\"%CHROME%\" \"%WORKDO_URL%\"" /sc weekly /d MON,TUE,WED,THU,FRI /st 08:50 /ru Administrator /rl highest /f
if %errorlevel% == 0 (echo [OK] WorkDoMorning - 週一至週五 08:50) else (echo [FAIL] WorkDoMorning)

:: 8. WorkDo 下午打卡提醒 週一至週五 17:00
schtasks /create /tn "WorkDoEvening" /tr "\"%CHROME%\" \"%WORKDO_URL%\"" /sc weekly /d MON,TUE,WED,THU,FRI /st 17:00 /ru Administrator /rl highest /f
if %errorlevel% == 0 (echo [OK] WorkDoEvening - 週一至週五 17:00) else (echo [FAIL] WorkDoEvening)

echo.
echo 立即啟動 config server...
schtasks /run /tn "YuantaConfigServer"

echo.
echo ========================================
echo 完成！排程清單：
echo   YuantaConfigServer  - 開機自動啟動
echo   YuantaSync          - 週一至週五 14:45
echo   YuantaCleanup       - 週一至週五 14:49
echo   YuantaOpenBrowser   - 週一至週五 14:50
echo   YuantaUnrealized    - 週一至週五 15:00
echo   YuantaDCA           - 週一至週五 15:05
echo   WorkDoMorning       - 週一至週五 08:50
echo   WorkDoEvening       - 週一至週五 17:00
echo ========================================
pause