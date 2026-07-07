###############################################################
# yuanta_sync_guard.py
# 守門包裝：啟動 yuanta_sync.py，攔截結束碼。
# 只要 yuanta_sync.py 以「非 0」結束（找不到檔案、崩潰、
# 未被內部 except 攔到的例外等），就發 Telegram 通知。
#
# 排程 YuantaSync 應改為執行本檔，而非直接執行 yuanta_sync.py，
# 才能補上「腳本根本沒啟動就完全靜默」的盲點。
###############################################################

import os
import sys
import ssl
import subprocess
import datetime
import collections
import urllib.request
import urllib.parse
from pathlib import Path

# ── SSL：32 位元 Python 預設憑證庫缺標準根憑證，改用 certifi ──
# （與 yuanta_sync.py 一致，否則連 api.telegram.org 會 CERTIFICATE_VERIFY_FAILED）
try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except Exception:
    _SSL_CTX = None

BASE_DIR = Path(__file__).parent
SYNC_SCRIPT = BASE_DIR / 'yuanta_sync.py'

# yuanta_sync.py 需要 32 位元 Python（元大 OneAPI DLL 限制）
SYNC_PYTHON = r'C:\Python311-32\python.exe'


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
TELEGRAM_CHAT  = os.environ.get('TELEGRAM_CHAT_ID', '')


def telegram_notify(msg: str):
    """發送 Telegram 訊息；設定缺失時靜默跳過"""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT:
        print('  [Telegram] Token/ChatId 未設定，略過')
        return
    try:
        url  = f'https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage'
        data = urllib.parse.urlencode({'chat_id': TELEGRAM_CHAT, 'text': msg}).encode()
        urllib.request.urlopen(url, data=data, timeout=10, context=_SSL_CTX)
    except Exception as e:
        print(f'  [Telegram] 發送失敗：{e}')


def main():
    now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    # 提前檢查：連檔案都不在就直接通知（不必等 subprocess）
    if not SYNC_SCRIPT.exists():
        telegram_notify(
            f'🚨 YuantaSync 排程異常\n'
            f'時間：{now}\n'
            f'原因：找不到 {SYNC_SCRIPT.name}（檔案遺失）'
        )
        print(f'[guard] 找不到 {SYNC_SCRIPT}，已發送通知')
        sys.exit(2)

    python_exe = SYNC_PYTHON if Path(SYNC_PYTHON).exists() else sys.executable

    tail = collections.deque(maxlen=30)   # 保留最後 30 行供通知使用
    proc = subprocess.Popen(
        [python_exe, str(SYNC_SCRIPT)],
        cwd=str(BASE_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding='utf-8',
        errors='replace',
    )
    for line in proc.stdout:
        sys.stdout.write(line)      # 原樣輸出，維持排程/終端可見
        tail.append(line.rstrip('\n'))
    proc.wait()
    code = proc.returncode

    if code != 0:
        hint = ''
        if code == 2:
            hint = '（找不到檔案／無法啟動）'
        tail_txt = '\n'.join(tail).strip() or '(無輸出)'
        telegram_notify(
            f'🚨 YuantaSync 排程異常\n'
            f'時間：{now}\n'
            f'結束碼：{code} {hint}\n'
            f'—— 最後輸出 ——\n'
            f'{tail_txt[-800:]}'
        )
        print(f'[guard] yuanta_sync.py 以非 0 結束（{code}），已發送 Telegram 通知')

    sys.exit(code)


if __name__ == '__main__':
    main()
