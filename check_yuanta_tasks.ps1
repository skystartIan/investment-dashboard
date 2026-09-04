# 檢查五個 Yuanta 排程當天是否真的跑起來且成功。
#
# 背景：2026-09-03 五個工作因 Interactive principal 全面靜默失敗（LastTaskResult 0x800710E0），
# 排程器回報「已排入」但根本沒啟動程序，guard 的 Telegram 也因此沒有機會觸發。
# 2026-09-04 改用 GroupId BUILTIN\Users principal 修復。詳見 yuanta_sync\CLAUDE.md 的 §4 與 §10。
#
# 用法：powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\Documents\check_yuanta_tasks.ps1
#      加 -Date yyyy-MM-dd 可檢查指定日期（預設今天）

param([string]$Date = (Get-Date -Format 'yyyy-MM-dd'))

$repo = 'C:\Users\Administrator\Documents\yuanta_sync'
$day  = [datetime]::ParseExact($Date, 'yyyy-MM-dd', $null)

$tasks = @(
    @{ Name = 'YuantaSync';       At = '14:45' }
    @{ Name = 'YuantaCleanup';    At = '14:49' }
    @{ Name = 'YuantaLogin';      At = '14:50' }
    @{ Name = 'YuantaUnrealized'; At = '15:00' }
    @{ Name = 'YuantaDCA';        At = '15:05' }
)

$fail = 0
$rows = foreach ($t in $tasks) {
    $info = Get-ScheduledTask -TaskName $t.Name | Get-ScheduledTaskInfo
    $st   = Get-ScheduledTask -TaskName $t.Name

    $ranToday = $info.LastRunTime -ge $day -and $info.LastRunTime -lt $day.AddDays(1)
    $rc       = $info.LastTaskResult
    $isGroup  = ($st.Principal.LogonType -eq 'Group')

    $verdict = if (-not $isGroup)  { 'principal 被改回去了' }
               elseif (-not $ranToday) { "沒有在 $Date 執行" }
               elseif ($rc -eq 267009) { '執行中' }
               elseif ($rc -ne 0)      { "結束碼 $rc" + $(if ($rc -eq 2147946720) { ' ← 又是 0x800710E0，principal 問題復發' } else { '' }) }
               else { 'OK' }

    if ($verdict -ne 'OK') { $script:fail++ }

    [pscustomobject]@{
        '工作'    = $t.Name
        '排定'    = $t.At
        '實際'    = if ($info.LastRunTime) { $info.LastRunTime.ToString('MM-dd HH:mm:ss') } else { '(無)' }
        '結束碼'  = $rc
        'principal' = if ($isGroup) { 'Group' } else { $st.Principal.LogonType }
        '判定'    = $verdict
    }
}

Write-Output "===== Yuanta 排程檢查：$Date ====="
$rows | Format-Table -AutoSize

Write-Output '----- 當天有沒有真的產生 log（排程器說成功還不夠）-----'
$ymd = $day.ToString('yyyy-MM-dd')

$sync = Join-Path $repo "logs\yuanta_sync_$ymd.log"
if (Test-Path $sync) { Write-Output "  [OK] $sync" }
else { Write-Output "  [!!] 缺 logs\yuanta_sync_$ymd.log"; $fail++ }

$login = Get-ChildItem (Join-Path $repo 'logs') -Filter "yuanta_login_*$ymd*.log" -ErrorAction SilentlyContinue
if ($login) { Write-Output ("  [OK] " + $login[0].Name) }
else { Write-Output "  [!!] 缺當天的 yuanta_login_*.log"; $fail++ }

$cl = Join-Path $repo 'cleanup_downloads.log'
$clToday = if (Test-Path $cl) { Select-String -Path $cl -Pattern ([regex]::Escape($ymd)) -SimpleMatch } else { $null }
if ($clToday) { Write-Output ("  [OK] cleanup_downloads.log 有 $ymd 的紀錄（" + $clToday.Count + " 行）") }
else { Write-Output "  [!!] cleanup_downloads.log 沒有 $ymd 的紀錄"; $fail++ }

Write-Output ''
Write-Output '----- downloads\（Login 下載、Unrealized/DCA 解析用）-----'
Get-ChildItem (Join-Path $repo 'downloads') -Filter '*.xls' -ErrorAction SilentlyContinue |
    Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize

Write-Output ''
if ($fail -eq 0) { Write-Output '===== 結論：五個排程全部正常 =====' }
else { Write-Output "===== 結論：有 $fail 項不正常，見上面的 [!!] 與「判定」欄 =====" }
exit $fail
