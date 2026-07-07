###############################################################
# yuanta_sync.py  v0.4
# 每天 14:45 自動跑，同步元大資料到 Google Sheets
###############################################################

import os
import sys
import time
import shutil
import datetime
import pathlib
import ssl
from pathlib import Path

# ── 自我檢查：元大 OneAPI DLL 只支援 32 位元，必須用 32 位元 Python ──
if sys.maxsize > 2**32:
    print('[錯誤] 此腳本必須用 32 位元 Python 執行（元大 OneAPI DLL 限制）')
    print(f'  目前 Python: {sys.executable}  maxsize={sys.maxsize}')
    print('  請改用: C:\\Python311-32\\python.exe')
    sys.exit(1)

# ── SSL 修正（Windows 憑證庫問題）──
import certifi
os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()
os.environ['SSL_CERT_FILE']      = certifi.where()
ssl._create_default_https_context = ssl.create_default_context

# ── Google Sheets ──────────────────────────────────────────
import gspread
from google.oauth2.service_account import Credentials

# ── 元大 OneAPI（Windows 專用）────────────────────────────
import clr
from System.Collections.Generic import List
import System

# ══════════════════════════════════════════════════════════
# 設定區（修改這裡）
# ══════════════════════════════════════════════════════════

# Google Sheets
CREDENTIALS_FILE = Path(__file__).parent / 'gen-lang-client-0554604905-c721d97aaf28.json'
SPREADSHEET_NAME = '投資日記'   # Google Sheets 的名稱

# 元大 OneAPI DLL 路徑
YUANTA_DLL_DIR  = Path(r'C:\Users\Administrator\Documents\yuanta_sync')
YUANTA_DLL_NAME = 'YuantaOneAPI'

# 元大 API 預設 log 輸出位置
YUANTA_LOG_SRC  = Path(r'C:\Yuanta\YuantaOneAPI\Log')

# 我們統一的 log 資料夾
LOG_DIR = Path(__file__).parent / 'logs'

# 元大帳號（從 .env 讀取，不寫死）
def load_env():
    env_path = Path(__file__).parent / '.env'
    if env_path.exists():
        for line in env_path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ[k.strip()] = v.strip()

load_env()
YUANTA_ACCOUNT  = os.environ.get('YUANTA_ACCOUNT', '')
YUANTA_PASSWORD = os.environ.get('YUANTA_PASSWORD', '')
TELEGRAM_TOKEN  = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT   = os.environ.get('TELEGRAM_CHAT_ID', '')


def telegram_notify(msg: str):
    """發送 Telegram 訊息；設定缺失時靜默跳過"""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT:
        return
    try:
        import urllib.request, urllib.parse, json as _json
        url  = f'https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage'
        data = urllib.parse.urlencode({'chat_id': TELEGRAM_CHAT, 'text': msg}).encode()
        urllib.request.urlopen(url, data=data, timeout=10)
    except Exception as e:
        print(f'  [Telegram] 發送失敗：{e}')

# 定期定額規則
DCA_RULES = {
    '0050': {'day': 10, 'budget': 20000},
    '2330': {'day': 10, 'budget': 10000},
}

# 質押成本補正
LENT_COST_OVERRIDE = {
    '0050': 314965,
}

# ══════════════════════════════════════════════════════════
# Tee：同時輸出到終端機 + log 檔
# ══════════════════════════════════════════════════════════

class Tee:
    """將 stdout/stderr 同時寫入終端機與 log 檔"""
    def __init__(self, *streams):
        self.streams = streams

    def write(self, data):
        for s in self.streams:
            s.write(data)
            s.flush()

    def flush(self):
        for s in self.streams:
            s.flush()

    def fileno(self):
        for s in self.streams:
            try:
                return s.fileno()
            except Exception:
                pass
        raise OSError('no real fileno available')


def setup_tee():
    """建立 logs/ 資料夾、開啟今日 log 檔、設定 Tee"""
    import io
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    today_str = datetime.date.today().isoformat()
    log_path = LOG_DIR / f'yuanta_sync_{today_str}.log'
    log_file = open(log_path, 'w', encoding='utf-8')

    # 強制 console 輸出用 UTF-8，避免 cp1252 無法顯示中文
    try:
        sys.__stdout__.reconfigure(encoding='utf-8', errors='replace')
        sys.__stderr__.reconfigure(encoding='utf-8', errors='replace')
        con_out = sys.__stdout__
        con_err = sys.__stderr__
    except (AttributeError, io.UnsupportedOperation):
        con_out = io.TextIOWrapper(sys.__stdout__.buffer, encoding='utf-8', errors='replace')
        con_err = io.TextIOWrapper(sys.__stderr__.buffer, encoding='utf-8', errors='replace')

    sys.stdout = Tee(con_out, log_file)
    sys.stderr = Tee(con_err, log_file)

    print(f'[log] 寫入：{log_path}', flush=True)
    return log_file


def collect_yuanta_logs(skip_locked=False):
    """
    把元大 API 在 YUANTA_LOG_SRC 產生的 log 檔移動到 LOG_DIR。
    skip_locked=True：跳過被鎖定的檔案，回傳鎖定檔案路徑清單。
    skip_locked=False：對鎖定檔案重試最多 10 次。
    """
    if not YUANTA_LOG_SRC.exists():
        print(f'  [元大log] 路徑不存在：{YUANTA_LOG_SRC}')
        return []

    moved = 0
    locked = []
    for f in YUANTA_LOG_SRC.glob('YuantaOneAPI_*'):
        dest = LOG_DIR / f.name
        max_attempts = 1 if skip_locked else 10
        for attempt in range(max_attempts):
            try:
                shutil.move(str(f), dest)
                moved += 1
                print(f'  [元大log] 移動：{f.name}')
                break
            except PermissionError:
                if skip_locked:
                    locked.append(f)
                elif attempt < max_attempts - 1:
                    print(f'  [元大log] 等待釋放（{attempt+1}/{max_attempts}）：{f.name}')
                    time.sleep(2)
                else:
                    print(f'  [元大log] 放棄（仍被鎖定）：{f.name}')
                    locked.append(f)
            except Exception as e:
                print(f'  [元大log] 移動失敗 {f.name}：{e}')
                break

    print(f'  [元大log] 共移動 {moved} 個檔案 → {LOG_DIR}')
    return locked


def collect_locked_logs_background(locked_files):
    """
    對鎖定的 log 檔，用背景 subprocess 等待並移動。
    主程式結束後 DLL 會釋放 handle，背景腳本再重試。
    """
    if not locked_files:
        return

    import subprocess, sys, json
    # 把檔案路徑和目標資料夾傳給內嵌腳本
    files_json = json.dumps([str(f) for f in locked_files])
    dest_dir   = str(LOG_DIR)
    script = (
        'import sys, json, shutil, time, pathlib\n'
        f'files = json.loads({repr(files_json)})\n'
        f'dest_dir = pathlib.Path({repr(dest_dir)})\n'
        'time.sleep(3)  # 等主程式結束\n'
        'for fp in files:\n'
        '    f = pathlib.Path(fp)\n'
        '    dest = dest_dir / f.name\n'
        '    for i in range(15):\n'
        '        try:\n'
        '            shutil.move(str(f), dest)\n'
        '            print(f"[背景] 移動成功：{f.name}")\n'
        '            break\n'
        '        except PermissionError:\n'
        '            time.sleep(2)\n'
        '        except Exception as e:\n'
        '            print(f"[背景] 失敗：{e}")\n'
        '            break\n'
    )
    subprocess.Popen(
        [sys.executable, '-c', script],
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    )
    print(f'  [元大log] {len(locked_files)} 個鎖定檔案交由背景處理')


# ══════════════════════════════════════════════════════════
# Google Sheets 工具
# ══════════════════════════════════════════════════════════

def get_sheets_client():
    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
    ]
    creds  = Credentials.from_service_account_file(str(CREDENTIALS_FILE), scopes=scopes)
    client = gspread.authorize(creds)
    return client

def get_or_create_sheet(wb, name, headers):
    """取得或建立 worksheet，並確保 header 存在"""
    try:
        ws = wb.worksheet(name)
    except gspread.WorksheetNotFound:
        ws = wb.add_worksheet(title=name, rows=1000, cols=len(headers))
        ws.append_row(headers, value_input_option='RAW')
        print(f'  [新建] {name}')
        return ws
    existing = ws.row_values(1) if ws.row_count > 0 else []
    if existing != headers:
        ws.clear()
        ws.append_row(headers, value_input_option='RAW')
        print(f'  [重設 header] {name}')
    return ws

def sheet_to_dicts(ws):
    return ws.get_all_records()

def overwrite_sheet(ws, headers, rows):
    ws.clear()
    ws.append_row(headers, value_input_option='RAW')
    if rows:
        ws.append_rows(rows, value_input_option='USER_ENTERED')

def append_rows_dedup(ws, headers, new_rows, key_cols):
    existing = ws.get_all_records()
    exist_keys = set()
    for r in existing:
        k = tuple(str(r.get(c, '')) for c in key_cols)
        exist_keys.add(k)

    to_add = []
    for row in new_rows:
        k = tuple(str(row[headers.index(c)]) for c in key_cols)
        if k not in exist_keys:
            to_add.append(row)
            exist_keys.add(k)

    if to_add:
        ws.append_rows(to_add, value_input_option='USER_ENTERED')
    return len(to_add)

# ══════════════════════════════════════════════════════════
# 元大 OneAPI 工具
# ══════════════════════════════════════════════════════════

def init_yuanta_dll():
    sys.path.append(str(YUANTA_DLL_DIR))
    clr.AddReference('System.Collections')
    clr.AddReference(YUANTA_DLL_NAME)

def parse_price(raw_long, decimal_places=2):
    return raw_long / (10 ** decimal_places)

_response_data = {}
_login_error_msg = ''

import threading
_evt_connected   = threading.Event()
_evt_loggedin    = threading.Event()
_evt_login_error = threading.Event()

def setup_response_handler(yuanta):
    from YuantaOneAPI import OnResponseEventHandler

    def on_response(intMark, dwIndex, strIndex, objHandle, objValue):
        global _login_error_msg
        import System.Text as _st
        if intMark == 0:
            msg = str(objValue)
            print(f'  [系統] {msg}', flush=True)
            if 'Connected!!' in msg and '交易主機' in msg:
                _evt_connected.set()
            if 'Disconnected' in msg and '交易主機' in msg:
                # 若登入尚未完成就斷線，視為登入失敗
                if not _evt_loggedin.is_set():
                    if not _login_error_msg:
                        _login_error_msg = '交易主機於登入期間斷線（可能是帳號密碼錯誤或憑證失效）'
                    _evt_login_error.set()
                _evt_connected.clear()
        elif intMark == 1:
            if isinstance(objValue, str):
                objValue = _st.Encoding.Default.GetBytes(objValue)
            key = strIndex if strIndex else str(dwIndex)
            _response_data[key] = objValue
            print(f'  [收到回應] strIndex="{strIndex}" dwIndex={dwIndex} → key="{key}"', flush=True)
            if key == 'Login':
                _evt_loggedin.set()
            elif not strIndex and not _evt_loggedin.is_set():
                # strIndex 為空且登入尚未成功，嘗試解讀伺服器回傳的錯誤訊息
                try:
                    raw = bytes(objValue)
                    decoded = raw.decode('cp950', errors='replace').rstrip('\x00').strip()
                    if decoded:
                        _login_error_msg = f'伺服器拒絕登入，回傳訊息：{decoded}'
                    else:
                        _login_error_msg = f'伺服器回傳未知錯誤（dwIndex={dwIndex}，資料長度={len(raw)} bytes）'
                except Exception as e:
                    _login_error_msg = f'伺服器回傳未知錯誤（dwIndex={dwIndex}，解碼失敗：{e}）'
                print(f'  [登入錯誤] {_login_error_msg}', flush=True)
                _evt_login_error.set()

    yuanta.OnResponse += OnResponseEventHandler(on_response)

def wait_response(key, timeout=15):
    for _ in range(timeout * 10):
        if key in _response_data:
            return _response_data.pop(key)
        time.sleep(0.1)
    print(f'  [timeout] 等不到 key="{key}"，目前有: {list(_response_data.keys())}', flush=True)
    return None

# ══════════════════════════════════════════════════════════
# 解析函式
# ══════════════════════════════════════════════════════════

def parse_holdings(abyData):
    from YuantaOneAPI import YuantaDataHelper, enumLangType
    dg = YuantaDataHelper(enumLangType.NORMAL)
    dg.OutMsgLoad(abyData)

    holdings = []
    try:
        count = dg.GetInt()
        for _ in range(count):
            account     = dg.GetStr(22)
            trade_kind  = dg.GetShort()
            market_no   = dg.GetByte()
            market_name = dg.GetStr(30)
            code        = dg.GetStr(12).strip()
            name        = dg.GetStr(30).strip()
            shares      = dg.GetLong()
            avg_price   = dg.GetLong()
            cost        = dg.GetLong()
            interest    = dg.GetLong()
            buy_not_in  = dg.GetInt()
            sell_not_in = dg.GetInt()
            can_order   = dg.GetLong()
            loan        = dg.GetLong()
            tax_rate    = dg.GetInt()
            lot_size    = dg.GetUInt()
            mkt_price   = dg.GetInt()
            decimal     = dg.GetShort()
            stk_type1   = dg.GetByte()
            stk_type2   = dg.GetByte()
            buy_price   = dg.GetInt()
            sell_price  = dg.GetInt()
            up_stop     = dg.GetInt()
            down_stop   = dg.GetInt()
            price_mult  = dg.GetUInt()
            currency    = dg.GetStr(3).strip()
            lent_shares = dg.GetLong()
            odd_qty     = dg.GetLong()

            if not code or shares <= 0:
                continue

            div = 10 ** decimal if decimal > 0 else 100
            base_cost = cost  # 不除 div
            lent_cost = LENT_COST_OVERRIDE.get(code.strip().zfill(4), 0)
            total_cost = base_cost + lent_cost

            holdings.append({
                'ticker':        code.zfill(4),
                'name':          name,
                'shares':        shares,
                'avg_cost':      round(avg_price / div, decimal),
                'current_price': round(mkt_price / div, decimal),
                'cost':          total_cost,   # 不 round
                'est_interest':  interest,
                'lent_shares':   lent_shares,
                'loan_amount':   round(loan / div, decimal),
                'market':        'TW',
            })
    except Exception as e:
        print(f'  [parse_holdings 錯誤] {e}')
    return holdings


def parse_trades(abyData):
    from YuantaOneAPI import YuantaDataHelper, enumLangType
    dg = YuantaDataHelper(enumLangType.NORMAL)
    dg.OutMsgLoad(abyData)
    trades = []
    try:
        # 第1組：現貨委託（略過）
        order_count = dg.GetInt()
        for _ in range(order_count):
            dg.GetStr(22); dg.GetTYuantaDate(); dg.GetByte(); dg.GetStr(30)
            dg.GetStr(12); dg.GetStr(30); dg.GetShort(); dg.GetStr(1)
            dg.GetLong(); dg.GetStr(1); dg.GetInt(); dg.GetInt(); dg.GetInt()
            dg.GetShort(); dg.GetTYuantaDate(); dg.GetTYuantaTime()
            dg.GetStr(5); dg.GetStr(5); dg.GetStr(120); dg.GetShort()
            dg.GetStr(3); dg.GetShort(); dg.GetInt(); dg.GetInt(); dg.GetInt()
            dg.GetStr(1); dg.GetStr(1); dg.GetStr(1); dg.GetStr(10)
            dg.GetStr(3); dg.GetStr(1); dg.GetStr(1); dg.GetStr(1)
            dg.GetStr(1); dg.GetStr(1); dg.GetInt(); dg.GetInt()
            dg.GetTYuantaDate(); dg.GetTYuantaTime()

        # 第2組：現貨成交
        deal_count = dg.GetInt()
        print(f'  [debug] 第2組筆數: {deal_count}')
        for _ in range(deal_count):
            account     = dg.GetStr(22)
            market_no   = dg.GetByte()
            market_name = dg.GetStr(30)
            code        = dg.GetStr(12).strip()
            name        = dg.GetStr(30).strip()
            order_type  = dg.GetShort()
            bs          = dg.GetStr(1).strip()
            qty         = dg.GetInt()
            order_price = dg.GetLong()
            deal_price  = dg.GetLong()
            dt          = dg.GetTYunataDateTime()
            order_no    = dg.GetStr(5)
            currency    = dg.GetStr(3)
            price_flag  = dg.GetStr(1)
            exchange    = dg.GetShort()

            if not code or qty <= 0:
                continue

            date_str = f"{dt.struDate.ushtYear}-{dt.struDate.bytMon:02d}-{dt.struDate.bytDay:02d}"
            trade_type = '盤中零股' if order_type == 4 else '現股'
            deal_amt = qty * round(deal_price / 10000, 2)
            fee = round(deal_amt * 0.001425 * 0.5887)
            tax = int(deal_amt * 0.003) if bs == 'S' else 0

            trades.append({
                'date':       date_str,
                'code':       code.zfill(4),
                'name':       name,
                'side':       '買' if bs == 'B' else '賣',
                'qty':        qty,
                'price':      round(deal_price / 10000, 2),
                'fee':        fee,
                'tax':        tax,
                'trade_type': trade_type,
                'order_no':   order_no.strip(),
                'note':       '',
            })

        # 第3組：期貨委託（略過）
        count3 = dg.GetInt()
        print(f'  [debug] 第3組筆數: {count3}')
        for _ in range(count3):
            dg.GetStr(22); dg.GetTYuantaDate(); dg.GetByte(); dg.GetStr(30)
            dg.GetStr(7); dg.GetInt(); dg.GetInt(); dg.GetStr(1)
            dg.GetStr(7); dg.GetInt(); dg.GetInt(); dg.GetStr(1)
            dg.GetStr(1); dg.GetStr(1); dg.GetStr(10); dg.GetInt()
            dg.GetInt(); dg.GetInt(); dg.GetShort(); dg.GetTYuantaDate()
            dg.GetTYuantaTime(); dg.GetStr(10); dg.GetStr(120); dg.GetStr(5)
            dg.GetStr(1); dg.GetShort(); dg.GetLong(); dg.GetLong()
            dg.GetLong(); dg.GetStr(1); dg.GetStr(1); dg.GetStr(1)
            dg.GetStr(30); dg.GetStr(30); dg.GetStr(1); dg.GetStr(20)
            dg.GetStr(3); dg.GetStr(3); dg.GetStr(10); dg.GetByte()
            dg.GetStr(12); dg.GetByte(); dg.GetStr(12); dg.GetStr(3)
            dg.GetStr(3)

        # 第4組：期貨成交（略過）
        count4 = dg.GetInt()
        print(f'  [debug] 第4組筆數: {count4}')
        for _ in range(count4):
            dg.GetStr(22); dg.GetByte(); dg.GetStr(30); dg.GetStr(7)
            dg.GetInt(); dg.GetStr(1); dg.GetInt(); dg.GetLong()
            dg.GetLong(); dg.GetTYuantaDate(); dg.GetTYuantaTime()
            dg.GetStr(5); dg.GetInt(); dg.GetStr(7); dg.GetInt()
            dg.GetStr(1); dg.GetInt(); dg.GetStr(1); dg.GetStr(1)
            dg.GetLong(); dg.GetStr(30); dg.GetStr(30); dg.GetStr(1)
            dg.GetStr(20); dg.GetStr(3); dg.GetStr(3); dg.GetStr(1)

        # 第5組：國際期貨委託（略過）
        count5 = dg.GetInt()
        print(f'  [debug] 第5組筆數: {count5}')
        for _ in range(count5):
            dg.GetStr(22); dg.GetTYuantaDate(); dg.GetByte(); dg.GetStr(30)
            dg.GetStr(7); dg.GetInt(); dg.GetStr(30); dg.GetStr(1)
            dg.GetStr(3); dg.GetStr(14); dg.GetStr(14); dg.GetInt()
            dg.GetInt(); dg.GetShort(); dg.GetTYuantaDate(); dg.GetTYuantaTime()
            dg.GetStr(10); dg.GetStr(120); dg.GetStr(8); dg.GetStr(1)
            dg.GetStr(1); dg.GetLong(); dg.GetInt(); dg.GetInt()
            dg.GetLong(); dg.GetInt(); dg.GetInt(); dg.GetStr(1)
            dg.GetStr(10); dg.GetByte(); dg.GetStr(12); dg.GetStr(3)
            dg.GetStr(3)

        # 第6組：現貨成交含手續費
        count6 = dg.GetInt()
        print(f'  [debug] 第6組筆數: {count6}')
        for _ in range(count6):
            account     = dg.GetStr(22)
            market_no   = dg.GetByte()
            market_name = dg.GetStr(30)
            code        = dg.GetStr(12).strip()
            name        = dg.GetStr(30).strip()
            bs          = dg.GetStr(1).strip()
            currency    = dg.GetStr(3)
            qty         = dg.GetInt()
            order_price = dg.GetLong()
            deal_price  = dg.GetLong()
            dt          = dg.GetTYunataDateTime()
            fee         = dg.GetInt()
            order_no    = dg.GetStr(7)
            settlement  = dg.GetLong()
            currency2   = dg.GetStr(3)

            if not code or qty <= 0:
                continue

            date_str = f"{dt.struDate.ushtYear}-{dt.struDate.bytMon:02d}-{dt.struDate.bytDay:02d}"
            deal_amt = qty * round(deal_price / 10000, 2)
            tax = int(deal_amt * 0.003) if bs == 'S' else 0

            trades.append({
                'date':       date_str,
                'code':       code.zfill(4),
                'name':       name,
                'side':       '買' if bs == 'B' else '賣',
                'qty':        qty,
                'price':      round(deal_price / 10000, 2),
                'fee':        fee,
                'tax':        tax,
                'trade_type': '現股',
                'order_no':   order_no.strip(),
                'note':       '',
            })

    except Exception as e:
        import traceback
        print(f'  [parse_trades 錯誤] {e}')
        traceback.print_exc()
    return trades


# ══════════════════════════════════════════════════════════
# DCA 偵測
# ══════════════════════════════════════════════════════════

def detect_dca(today_holdings, yesterday_holdings, today_trades, today_str):
    today_date = datetime.date.fromisoformat(today_str)
    dca_trades = []
    # 只排除已有「定期定額」記錄的 code，一般盤中零股買賣不應阻擋 DCA 偵測
    dca_traded_codes = {t['code'] for t in today_trades if t.get('trade_type') == '定期定額'}
    yesterday_map = {h['ticker']: h for h in yesterday_holdings}

    for h in today_holdings:
        code = h['ticker']
        if code not in DCA_RULES:
            continue
        rule = DCA_RULES[code]
        if abs(today_date.day - rule['day']) > 3:
            continue
        if code in dca_traded_codes:
            continue
        old = yesterday_map.get(code)
        if old is None:
            continue
        delta = h['shares'] - old['shares']
        if delta <= 0:
            continue

        dca_price = round((h['avg_cost'] * h['shares'] - old['avg_cost'] * old['shares']) / delta, 2)
        estimated_amt = delta * dca_price
        if estimated_amt > rule['budget'] * 1.1:
            continue

        print(f'  [DCA偵測] {code} {h["name"]} +{delta}股 @ {dca_price} ≈ NT${round(estimated_amt):,}')
        dca_trades.append({
            'date': today_str, 'code': code, 'name': h['name'],
            'side': '買', 'qty': delta, 'price': dca_price,
            'fee': 1, 'tax': 0, 'trade_type': '定期定額', 'order_no': '', 'note': '',
        })

    return dca_trades

# ══════════════════════════════════════════════════════════
# prices_tw 寫入
# ══════════════════════════════════════════════════════════

def _apply_prices_tw_format(ws, header):
    """
    個股價格欄（股票代碼欄）→ 純數字 #,##0.##（不顯示 NT$）
    TOTAL_MV / UNREALIZED / UNREALIZED_YUANTA → NT$ 貨幣格式
    date / TAIEX → 維持預設
    """
    from gspread.utils import rowcol_to_a1
    currency_cols   = {'TOTAL_MV', 'UNREALIZED', 'UNREALIZED_YUANTA'}
    skip_cols       = {'date', 'TAIEX'}

    ticker_indices  = []   # 1-based 欄號
    currency_indices = []

    for i, col in enumerate(header):
        col_num = i + 1
        if col in skip_cols:
            continue
        if col in currency_cols:
            currency_indices.append(col_num)
        else:
            ticker_indices.append(col_num)

    def to_col_letter(col_num):
        return rowcol_to_a1(1, col_num).rstrip('0123456789')

    # 個股價格欄：純數字（以連續範圍一次 format）
    if ticker_indices:
        start = to_col_letter(min(ticker_indices))
        end   = to_col_letter(max(ticker_indices))
        ws.format(f'{start}:{end}', {'numberFormat': {'type': 'NUMBER', 'pattern': '#,##0.##'}})
        print(f'  [prices_tw] 個股欄 {start}:{end} → 純數字格式')

    # 匯總欄：NT$ 貨幣格式（逐欄設定，通常只有 3 欄）
    for col_num in currency_indices:
        letter = to_col_letter(col_num)
        ws.format(f'{letter}:{letter}', {'numberFormat': {'type': 'CURRENCY', 'pattern': '"NT$"#,##0'}})
    if currency_indices:
        letters = [to_col_letter(c) for c in currency_indices]
        print(f'  [prices_tw] 匯總欄 {letters} → NT$ 貨幣格式')


def write_prices_tw(wb, today_holdings, today_str):
    """
    從今日持倉的 current_price 寫一行到 prices_tw
    header 只增不減：新標的加欄，已賣掉的標的保留欄位（當天填空）
    """
    today_tickers = [h['ticker'].zfill(4) for h in today_holdings]

    try:
        ws = wb.worksheet('prices_tw')
    except gspread.WorksheetNotFound:
        ws = wb.add_worksheet(title='prices_tw', rows=1000, cols=len(today_tickers) + 2)

    # 讀現有資料
    all_data = ws.get_all_values()
    existing_header = all_data[0] if all_data else []

    # 將 1~3 位數的股票代碼補零（0050 → 0050，避免 Google Sheets 存成 50）
    import re as _re
    def _norm_ticker(t):
        return t.zfill(4) if _re.match(r'^\d{1,3}$', t) else t

    # 現有 header 裡的股票欄（排除 date / TAIEX），並補齊前導零
    existing_tickers = [_norm_ticker(col) for col in existing_header if col not in {'date', 'TAIEX', 'TOTAL_MV', 'UNREALIZED', 'UNREALIZED_YUANTA'}]

    # 合併：保留舊的順序 + 補上新出現的
    existing_set = set(existing_tickers)
    merged_tickers = existing_tickers + sorted([t for t in today_tickers if t not in existing_set])

    new_header = ['date'] + merged_tickers + ['TAIEX', 'TOTAL_MV', 'UNREALIZED', 'UNREALIZED_YUANTA']

    # header 有變動才重寫（含前導零修正也算變動）
    if new_header != existing_header:
        # 建立「normalize 後的欄名 → 原始欄位索引」的 mapping，讓 0050 能對到原來的 50 欄
        norm_col_index = {}
        for i, col in enumerate(existing_header):
            norm_col_index[_norm_ticker(col)] = i
        realigned = []
        for row in all_data[1:]:
            new_row = []
            for col in new_header:
                if col in norm_col_index:
                    idx = norm_col_index[col]
                    new_row.append(row[idx] if idx < len(row) else '')
                else:
                    new_row.append('')  # 新欄，舊資料留空
            realigned.append(new_row)

        ws.clear()
        ws.append_row(new_header, value_input_option='RAW')
        if realigned:
            ws.append_rows(realigned, value_input_option='RAW')
        print(f'  [prices_tw] header 更新：{new_header}')

        # 套用格式：個股價格欄 → 純數字；TOTAL_MV/UNREALIZED/UNREALIZED_YUANTA → NT$ 貨幣
        _apply_prices_tw_format(ws, new_header)

    # 去重：今天已寫過就跳過
    all_data = ws.get_all_values()
    if any(r[0] == today_str for r in all_data[1:]):
        print(f'  [prices_tw] 今日 {today_str} 已存在，跳過')
        return

    # 抓大盤指數
    taiex = ''
    try:
        import urllib.request, json
        url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            taiex = data['msgArray'][0].get('z', '')
        print(f'  [prices_tw] TAIEX = {taiex}')
    except Exception as e:
        print(f'  [prices_tw] 抓大盤失敗：{e}')

    # 組今日 row，對齊 merged_tickers（沒持有的填空）
    price_map = {h['ticker'].zfill(4): h['current_price'] for h in today_holdings}

    # 用 today_holdings 計算當日總市值和未實現損益
    ETF_LIST = {'0050', '0056'}
    total_mv   = sum((h['shares'] + h['lent_shares']) * h['current_price'] for h in today_holdings)
    total_cost = sum(h['cost'] for h in today_holdings)
    sell_fee  = total_mv * 0.001425
    etf_mv    = sum((h['shares'] + h['lent_shares']) * h['current_price'] for h in today_holdings if h['ticker'].zfill(4) in ETF_LIST)
    stock_mv  = total_mv - etf_mv
    sell_tax  = etf_mv * 0.001 + stock_mv * 0.003
    unrealized = round(total_mv - total_cost - sell_fee - sell_tax)
    
    row = [today_str] + [price_map.get(t, '') for t in merged_tickers] + [taiex, round(total_mv), unrealized, '']

    ws.append_row(row, value_input_option='RAW')
    print(f'  ✓ prices_tw 新增 {today_str}，共 {len(merged_tickers)} 欄（今日持有 {len(today_tickers)} 檔）')

    # 降冪排序（最新在最上面）
    all_price_data = ws.get_all_values()
    if len(all_price_data) > 2:
        hdr_row   = all_price_data[0]
        data_rows = sorted(all_price_data[1:], key=lambda r: r[0], reverse=True)
        ws.clear()
        ws.append_row(hdr_row, value_input_option='RAW')
        ws.append_rows(data_rows, value_input_option='RAW')
        print(f'  ✓ prices_tw 降冪排序完成（{len(data_rows)} 列）')

# ══════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════

HEADERS = {
    'holdings_tw': ['ticker','name','shares','avg_cost','current_price','cost','est_interest','lent_shares','loan_amount','market','市值','總成本','未實現損益'],
    'trades_tw':   ['date','code','name','side','qty','price','fee','tax','trade_type','order_no','note'],
    'prices_tw':   [],
    'lending':     ['ticker','name','shares','lent_shares','date','rate','income'],
}

def main():
    log_file = setup_tee()

    today_str = datetime.date.today().isoformat()
    print(f'\n{"="*50}')
    print(f'yuanta_sync.py  {today_str}')
    print(f'{"="*50}')

    try:
        # ── 0. 判斷是否為交易日 ──
        # 用 TWSE 即時報價的加權指數成交價 z 判斷：有值代表盤中/已收盤有成交，
        # z=='-' 代表尚未開盤或非交易日（此 API 為即時盤中資料，無歷史）。
        print('\n[0] 確認今日是否為交易日...')
        is_trading = False

        try:
            import urllib.request, json
            url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw'
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
                z = data['msgArray'][0].get('z', '-')
                if z == '-':
                    print(f'  今日 {today_str} 尚未開盤或非交易日（無即時成交價），結束。')
                else:
                    print(f'  ✓ 今日為交易日，大盤最新價：{z}')
                    is_trading = True
        except Exception as e:
            print(f'  [交易日偵測失敗] {e}，預設繼續執行')
            is_trading = True

        if not is_trading:
            return

        # ── 1. 連線 Google Sheets ──
        print('\n[1] 連線 Google Sheets...')
        gc = get_sheets_client()
        wb = gc.open(SPREADSHEET_NAME)
        print(f'  ✓ 已連線：{SPREADSHEET_NAME}')
        ws_holdings = get_or_create_sheet(wb, 'holdings_tw', HEADERS['holdings_tw'])
        ws_trades   = get_or_create_sheet(wb, 'trades_tw',   HEADERS['trades_tw'])

        # ── 2. 讀取昨日持倉 ──
        print('\n[2] 讀取昨日持倉...')
        yesterday_holdings = sheet_to_dicts(ws_holdings)
        print(f'  昨日持倉 {len(yesterday_holdings)} 筆')

        # ── 3. 連線元大 OneAPI ──
        print('\n[3] 連線元大 OneAPI...')
        init_yuanta_dll()

        from YuantaOneAPI import (
            YuantaOneAPITrader, enumEnvironmentMode,
            OnResponseEventHandler, YuantaDataHelper, enumLangType, enumLogType
        )

        yuanta = YuantaOneAPITrader()
        setup_response_handler(yuanta)
        yuanta.SetLogType(enumLogType.COMMON)

        yuanta.Open(enumEnvironmentMode.PROD)
        if _evt_connected.wait(timeout=15):
            print('  ✓ 交易主機連線成功')
        else:
            print('  [錯誤] 交易主機連線逾時，請確認 Proxifier 規則')
            yuanta.Close()
            return

        _evt_loggedin.clear()
        _evt_login_error.clear()
        yuanta.Login(YUANTA_ACCOUNT, YUANTA_PASSWORD)

        done = threading.Event()
        def _wait_login():
            # 等成功或失敗其中一個先到
            while not done.is_set():
                if _evt_loggedin.wait(timeout=0.1):
                    break
                if _evt_login_error.wait(timeout=0.1):
                    break
        t = threading.Thread(target=_wait_login, daemon=True)
        t.start()
        t.join(timeout=15)
        done.set()

        if _evt_loggedin.is_set():
            print(f'  ✓ 登入成功：{YUANTA_ACCOUNT}')
        else:
            if _login_error_msg:
                print(f'  [錯誤] 登入失敗：{_login_error_msg}')
            else:
                print(f'  [錯誤] 登入逾時（15 秒內無回應），帳號：{YUANTA_ACCOUNT}')
            print('  → 建議確認：1) OneAPI 密碼是否過期  2) 帳號是否被鎖定  3) 網路/Proxifier 規則')
            yuanta.Close()
            return

        # ── 4. 抓現貨庫存 ──
        print('\n[4] 抓現貨庫存 SummaryReport...')
        raw_holdings = None
        for attempt in range(3):
            _response_data.pop('20.103.0.22', None)
            ds2 = YuantaDataHelper(enumLangType.NORMAL)
            ds2.SetFunctionID(20, 103, 0, 22)
            ds2.SetUInt(1)
            ds2.SetTByte(YUANTA_ACCOUNT, 22)
            yuanta.RQ(YUANTA_ACCOUNT, ds2)
            raw_holdings = wait_response('20.103.0.22', timeout=20)
            if raw_holdings is not None:
                break
            if attempt < 2:
                print(f'  [重試] SummaryReport 無回應，10 秒後第 {attempt + 2} 次...')
                time.sleep(10)

        if raw_holdings is None:
            print('  [錯誤] SummaryReport 重試 3 次仍無回應')
            yuanta.Close()
            return
        today_holdings = parse_holdings(raw_holdings)
        print(f'  ✓ 持倉 {len(today_holdings)} 筆')

        # ── 5. 抓委託成交 ──
        print('\n[5] 抓委託成交 OrderTradeReport...')
        raw_trades = None
        for attempt in range(3):
            _response_data.pop('20.101.0.18', None)
            ds3 = YuantaDataHelper(enumLangType.NORMAL)
            ds3.SetFunctionID(20, 101, 0, 18)
            ds3.SetTByte('Y', 1)
            ds3.SetUInt(1)
            ds3.SetTByte(YUANTA_ACCOUNT, 22)
            yuanta.RQ(YUANTA_ACCOUNT, ds3)
            raw_trades = wait_response('20.101.0.18', timeout=20)
            if raw_trades is not None:
                break
            if attempt < 2:
                print(f'  [重試] OrderTradeReport 無回應，10 秒後第 {attempt + 2} 次...')
                time.sleep(10)

        today_trades = []
        if raw_trades:
            today_trades = parse_trades(raw_trades)
            print(f'  ✓ 成交 {len(today_trades)} 筆')
        else:
            print('  (今日無成交或重試後仍無回應)')

        # ── 6. 偵測定期定額 ──
        print('\n[6] 偵測定期定額...')
        dca_trades = detect_dca(today_holdings, yesterday_holdings, today_trades, today_str)
        all_trades = today_trades + dca_trades
        print(f'  成交 {len(today_trades)} 筆 + DCA {len(dca_trades)} 筆 = {len(all_trades)} 筆')

        # ── 7. 登出 ──
        yuanta.Close()
        print('\n[7] 元大 OneAPI 已關閉')
        time.sleep(2)

        # ── 8. 寫入 Google Sheets ──
        print('\n[8] 寫入 Google Sheets...')
        rows = []
        ETF_LIST = {'0050', '0056'}
        for h in today_holdings:
            total_shares = h['shares'] + h['lent_shares']
            market_value = total_shares * h['current_price']
            total_cost   = h['cost']
            sell_fee_h   = market_value * 0.001425
            tax_rate_h   = 0.001 if str(h['ticker']).zfill(4) in ETF_LIST else 0.003
            sell_tax_h   = market_value * tax_rate_h
            unrealized   = round(market_value - total_cost - sell_fee_h - sell_tax_h)
            row = [h[k] for k in HEADERS['holdings_tw'][:-3]]  # 前10欄
            row[0] = "'" + str(h['ticker']).zfill(4)
            row += [market_value, total_cost, unrealized]
            rows.append(row)
        # 加總列
        total_row = ['', '合計', '', '', '', '', '', '', '', '',
                     sum(r[10] for r in rows),
                     sum(r[11] for r in rows),
                     sum(r[12] for r in rows)]
        rows_with_total = rows + [total_row]
        overwrite_sheet(ws_holdings, HEADERS['holdings_tw'], rows_with_total)
        print(f'  ✓ holdings_tw 更新 {len(rows)} 筆')

        if all_trades:
            trade_rows = [[t[k] for k in HEADERS['trades_tw']] for t in all_trades]
            added = append_rows_dedup(ws_trades, HEADERS['trades_tw'], trade_rows,
                                      key_cols=['date','code','side','qty','order_no'])
            print(f'  ✓ trades_tw 新增 {added} 筆')
        else:
            print('  trades_tw 無新增')

        # ── trades_tw 降冪排序（最新在最上面）──
        all_trade_data = ws_trades.get_all_values()
        if len(all_trade_data) > 2:
            hdr_row   = all_trade_data[0]
            data_rows = sorted(all_trade_data[1:], key=lambda r: r[0], reverse=True)
            ws_trades.clear()
            ws_trades.append_row(hdr_row, value_input_option='RAW')
            ws_trades.append_rows(data_rows, value_input_option='USER_ENTERED')
            print(f'  ✓ trades_tw 降冪排序完成（{len(data_rows)} 筆）')

        lent = [h for h in today_holdings if h.get('lent_shares', 0) > 0]
        if lent:
            ws_lending = get_or_create_sheet(wb, 'lending', HEADERS['lending'])
            lent_rows = [[h['ticker'], h['name'], h['shares'], h['lent_shares'],
                          today_str, '', ''] for h in lent]
            overwrite_sheet(ws_lending, HEADERS['lending'], lent_rows)
            print(f'  ✓ lending 更新 {len(lent_rows)} 筆')

        # ── prices_tw ──
        write_prices_tw(wb, today_holdings, today_str)

        # ── 時間戳：寫 tw_synced_at 到 config ──
        try:
            ws_config = get_or_create_sheet(wb, 'config', [])
            config_data = ws_config.get_all_values()
            now_str = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            key = 'tw_synced_at'
            found = False
            for i, row in enumerate(config_data):
                if row and row[0] == key:
                    ws_config.update_cell(i + 1, 2, now_str)
                    found = True
                    break
            if not found:
                ws_config.append_row([key, now_str, ''], value_input_option='RAW')
            print(f'  ✓ config tw_synced_at = {now_str}')
        except Exception as e:
            print(f'  [警告] 寫時間戳失敗：{e}')

        # ── 9. 收集元大 log ──
        print('\n[9] 收集元大 log...')
        locked = collect_yuanta_logs(skip_locked=True)
        collect_locked_logs_background(locked)

        print(f'\n{"="*50}')
        print(f'✅ 完成！{today_str}')
        print(f'{"="*50}\n')
        telegram_notify(
            f'✅ yuanta_sync 完成 {today_str}\n'
            f'持倉 {len(today_holdings)} 檔｜成交 {len(today_trades)} 筆｜DCA {len(dca_trades)} 筆'
        )

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f'\n[FATAL ERROR] {e}', flush=True)
        print(tb, flush=True)
        telegram_notify(
            f'❌ yuanta_sync 失敗 {datetime.date.today().isoformat()}\n'
            f'{type(e).__name__}: {e}\n\n'
            f'{tb[-400:]}'
        )

    finally:
        sys.stdout = sys.__stdout__
        sys.stderr = sys.__stderr__
        log_file.close()

if __name__ == '__main__':
    main()