###############################################################
# yuanta_task_watchdog.py
# 排程守望：確認當天五個 Yuanta 排程「真的跑起來且成功」，異常發 Telegram。
#
# 為什麼需要它：yuanta_sync_guard.py 補的是「腳本沒啟動」；
# 2026-09-03 的事故是「排程沒啟動」—— 工作排程器因 Interactive principal
# 回 0x800710E0，連 guard 都沒被執行，於是完全靜默（見 CLAUDE.md §4、§10）。
# 這一層補的就是那個盲點：從排程器外面看進去。
#
# 檢查邏輯放在 check_yuanta_tasks.ps1（可單獨手動執行），
# 本檔只負責跑它、判讀結束碼、發通知 —— 只有一份判斷標準。
#
# 排程 YuantaTaskCheck 執行本檔，並照專案慣例包在 guard 底下：
#   python yuanta_sync_guard.py yuanta_task_watchdog.py C:\Python311-arm64\python.exe
# 這樣連「watchdog 自己掛掉」也會有 Telegram。
#
# 用法：
#   python yuanta_task_watchdog.py              # 正常執行，異常才發
#   python yuanta_task_watchdog.py --dry-run    # 只印出會發什麼，不真的發
#   python yuanta_task_watchdog.py --force      # 不論結果都發一則（測通道用）
###############################################################

import os
import ssl
import sys
import datetime
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    _SSL_CTX = None

BASE_DIR = Path(__file__).parent
CHECK_PS1 = BASE_DIR / 'check_yuanta_tasks.ps1'
LOG_PATH = BASE_DIR / 'logs' / 'task_watchdog.log'

DRY_RUN = '--dry-run' in sys.argv
FORCE = '--force' in sys.argv


def log(msg: str):
    """同時印出與寫檔。排程執行時 stdout 不知去向，沒有檔案就等於沒發生過 ——
    而「沒有痕跡」正是這支腳本要防的毛病。"""
    print(msg)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with LOG_PATH.open('a', encoding='utf-8') as f:
            f.write(f'{stamp} {msg}\n')
    except Exception as e:
        print(f'  [log] 寫入失敗：{e}')


def load_env():
    env_path = BASE_DIR / '.env'
    if env_path.exists():
        for line in env_path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ[k.strip()] = v.strip()


load_env()
TELEGRAM_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT = os.environ.get('TELEGRAM_CHAT_ID', '')


def telegram_notify(msg: str):
    if DRY_RUN:
        print('—— [dry-run] 以下訊息不會真的送出 ——')
        print(msg)
        return
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT:
        log('  [Telegram] Token/ChatId 未設定，略過')
        return
    try:
        url = f'https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage'
        data = urllib.parse.urlencode({'chat_id': TELEGRAM_CHAT, 'text': msg}).encode()
        urllib.request.urlopen(url, data=data, timeout=10, context=_SSL_CTX)
        log('  [Telegram] 已送出')
    except Exception as e:
        log(f'  [Telegram] 發送失敗：{e}')


def run_check():
    """跑 check_yuanta_tasks.ps1，回傳 (結束碼, 輸出)。結束碼＝不正常的項數。"""
    # PowerShell 5.1 導向到管道時預設用 OEM codepage（本機為 cp950），
    # 中文會變亂碼 —— 在子行程裡先把 OutputEncoding 改成 UTF-8
    cmd = [
        'powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
        f"& '{CHECK_PS1}'; exit $LASTEXITCODE",
    ]
    proc = subprocess.run(
        cmd, cwd=str(BASE_DIR), capture_output=True,
        text=True, encoding='utf-8', errors='replace', timeout=180,
    )
    return proc.returncode, (proc.stdout or '') + (proc.stderr or '')


def run_prices_scan(days=10):
    """跑 yuanta_prices_backfill.py --scan，回傳 (缺口數, 輸出)。
    腳本不在或跑不起來時回 (0, 說明) —— 缺少這一層不該讓整個守望失敗。"""
    script = BASE_DIR / 'yuanta_prices_backfill.py'
    if not script.exists():
        return 0, f'[scan] 找不到 {script.name}，略過資料缺口檢查'
    try:
        proc = subprocess.run(
            [sys.executable, str(script), '--scan', str(days)],
            cwd=str(BASE_DIR), capture_output=True,
            text=True, encoding='utf-8', errors='replace', timeout=300,
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
        )
        return proc.returncode, (proc.stdout or '') + (proc.stderr or '')
    except Exception as e:
        return 0, f'[scan] 無法執行：{e}'


def main():
    now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    if not CHECK_PS1.exists():
        telegram_notify(
            f'🚨 排程守望異常\n'
            f'時間：{now}\n'
            f'原因：找不到 {CHECK_PS1.name}（檔案遺失）'
        )
        log(f'[watchdog] 找不到 {CHECK_PS1}')
        sys.exit(2)

    try:
        code, out = run_check()
    except Exception as e:
        telegram_notify(
            f'🚨 排程守望異常\n'
            f'時間：{now}\n'
            f'原因：檢查腳本無法執行 —— {e}'
        )
        log(f'[watchdog] 檢查腳本無法執行：{e}')
        sys.exit(2)

    print(out)

    # 排程有沒有跑，跟資料完不完整，是兩件事。
    # 2026-09-03 那天兩件都出事；2026-09-04 排程全綠，但 us_prices 照樣缺一天。
    # 所以這裡另外查 prices_tw 有沒有洞 —— 結束碼＝真正的缺口數（已排除假日）。
    gaps_code, gaps_out = run_prices_scan()
    print(gaps_out)

    if code == 0 and gaps_code == 0 and not FORCE:
        log('[watchdog] 五個排程正常、prices_tw 無缺口，不發通知')
        sys.exit(0)

    # 只取表格與結論，避開 downloads 清單那段雜訊
    body = out.strip()
    if len(body) > 2000:
        body = body[:1000] + '\n……\n' + body[-1000:]

    if code != 0:
        head = '🚨 Yuanta 排程異常'
    elif gaps_code > 0:
        head = '🚨 Yuanta 資料缺口'
    else:
        head = '✅ Yuanta 檢查（--force 測試）'

    msg = (f'{head}\n'
           f'時間：{now}\n'
           f'排程不正常項數：{code}\n'
           f'prices_tw 缺口：{gaps_code}\n'
           f'—— 排程檢查 ——\n'
           f'{body}\n')
    if gaps_code > 0:
        tail = gaps_out.strip()[-700:]
        msg += (f'—— 資料缺口 ——\n{tail}\n'
                f'補法：python yuanta_prices_backfill.py --date <日期> --commit\n')
    msg += '—— 排查 ——\n結束碼 2147946720 = principal 問題復發，見 CLAUDE.md §4。'

    telegram_notify(msg)
    log(f'[watchdog] 已回報（排程 {code} 項、資料缺口 {gaps_code} 天）')

    # 這裡刻意 exit 0：watchdog 本身「成功完成了它的工作」。
    # 非 0 會讓外層的 guard 再發一則重複的 Telegram。
    sys.exit(0)


if __name__ == '__main__':
    main()
