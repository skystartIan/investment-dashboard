"""
yuanta_dividend_sync.py  v0.1 (測試階段)

核心邏輯：把 GetExDividends API 的 raw 資料轉換成 dividends_tw 要的格式，
包含「重播 trades_tw 計算除息日當下持股數」「判斷 received/upcoming」
「dedup 寫入 Google Sheets」。

目前為獨立模組，尚未掛進 yuanta_sync.py 每日排程（依規劃先獨立驗證）。
"""

import time
from datetime import datetime, date
from pathlib import Path

import gspread
from google.oauth2.service_account import Credentials


def _with_retry(fn, attempts=3, delay=3):
    """Google Sheets API 偶有暫時性 503/500，重試幾次再放棄"""
    last_err = None
    for i in range(attempts):
        try:
            return fn()
        except gspread.exceptions.APIError as e:
            last_err = e
            log(f'  ⚠️ Sheets API 暫時性錯誤（第 {i + 1}/{attempts} 次）：{e}')
            if i < attempts - 1:
                time.sleep(delay)
    raise last_err

BASE_DIR = Path(__file__).parent
CREDENTIALS_FILE = BASE_DIR / 'gen-lang-client-0554604905-c721d97aaf28.json'
SPREADSHEET_NAME = '投資日記'

DIVIDENDS_HEADERS = ['date', 'code', 'name', 'shares', 'cps', 'amount', 'pay_date', 'status']

# 現有前端硬編碼的歷史股利紀錄（一次性遷移用）
HISTORICAL_RECORDS = [
    {'code': '0050', 'name': '元大台灣50', 'date': '2024-07-16', 'shares': 3383, 'cps': 1.000},
    {'code': '0050', 'name': '元大台灣50', 'date': '2025-01-17', 'shares': 4451, 'cps': 2.700},
    {'code': '0050', 'name': '元大台灣50', 'date': '2025-07-21', 'shares': 20144, 'cps': 0.360},
    {'code': '0050', 'name': '元大台灣50', 'date': '2026-01-22', 'shares': 19281, 'cps': 1.000},
    {'code': '0056', 'name': '元大高股息', 'date': '2024-07-16', 'shares': 11195, 'cps': 1.070},
    {'code': '0056', 'name': '元大高股息', 'date': '2024-10-17', 'shares': 11994, 'cps': 1.070},
    {'code': '0056', 'name': '元大高股息', 'date': '2025-01-17', 'shares': 17788, 'cps': 1.070},
    {'code': '0056', 'name': '元大高股息', 'date': '2025-04-23', 'shares': 20637, 'cps': 1.070},
    {'code': '0056', 'name': '元大高股息', 'date': '2025-07-21', 'shares': 21515, 'cps': 0.866},
    {'code': '0056', 'name': '元大高股息', 'date': '2025-10-23', 'shares': 18342, 'cps': 0.866},
    {'code': '2330', 'name': '台積電', 'date': '2024-09-12', 'shares': 141, 'cps': 4.000},
    {'code': '2330', 'name': '台積電', 'date': '2024-12-12', 'shares': 141, 'cps': 4.000},
    {'code': '2330', 'name': '台積電', 'date': '2025-03-18', 'shares': 141, 'cps': 4.500},
    {'code': '2330', 'name': '台積電', 'date': '2025-06-12', 'shares': 141, 'cps': 4.500},
    {'code': '2330', 'name': '台積電', 'date': '2025-09-16', 'shares': 141, 'cps': 5.000},
    {'code': '2330', 'name': '台積電', 'date': '2025-12-11', 'shares': 141, 'cps': 5.000},
    {'code': '2330', 'name': '台積電', 'date': '2026-03-17', 'shares': 157, 'cps': 6.000},
    {'code': '2344', 'name': '華邦電', 'date': '2026-03-27', 'shares': 450, 'cps': 0.500},
    {'code': '2454', 'name': '聯發科', 'date': '2025-07-03', 'shares': 16, 'cps': 25.000},
    {'code': '8996', 'name': '高力', 'date': '2026-03-27', 'shares': 35, 'cps': 4.555},
]


def log(msg: str):
    print(f'[股利同步] {msg}')


# ──────────────────────────────────────────────────────────
# Google Sheets
# ──────────────────────────────────────────────────────────

def get_sheets_client():
    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
    ]
    creds = Credentials.from_service_account_file(str(CREDENTIALS_FILE), scopes=scopes)
    return gspread.authorize(creds)


def get_or_create_sheet(wb, name, headers):
    try:
        ws = wb.worksheet(name)
    except gspread.WorksheetNotFound:
        ws = wb.add_worksheet(title=name, rows=1000, cols=len(headers))
        ws.append_row(headers, value_input_option='RAW')
        log(f'[新建] {name}')
        return ws
    existing = ws.row_values(1) if ws.row_count > 0 else []
    if existing != headers:
        ws.clear()
        ws.append_row(headers, value_input_option='RAW')
        log(f'[重設 header] {name}')
    return ws


def read_holding_codes(wb) -> set:
    """從 holdings_tw 讀取目前持股的股票代號集合"""
    try:
        ws = wb.worksheet('holdings_tw')
    except gspread.WorksheetNotFound:
        log('⚠️ holdings_tw 不存在')
        return set()
    records = _with_retry(lambda: ws.get_all_records(numericise_ignore=['all']))
    codes = set()
    for r in records:
        code = str(r.get('ticker', '')).strip()
        if code and code != '合計' and code.lower() != 'total':
            codes.add(code)
    return codes


def read_trades(wb) -> list:
    """從 trades_tw 讀取全部成交紀錄"""
    try:
        ws = wb.worksheet('trades_tw')
    except gspread.WorksheetNotFound:
        log('⚠️ trades_tw 不存在')
        return []
    records = _with_retry(lambda: ws.get_all_records(numericise_ignore=['all']))
    trades = []
    for r in records:
        date_str = str(r.get('date', '')).strip()[:10]
        code = str(r.get('code', '')).strip()
        side = str(r.get('side', '')).strip().upper()
        qty = r.get('qty', 0)
        if not date_str or not code:
            continue
        try:
            qty = float(qty)
        except (TypeError, ValueError):
            qty = 0
        trades.append({'date': date_str, 'code': code, 'side': side, 'qty': qty})
    return trades


def append_rows_dedup(ws, headers, new_rows, key_cols):
    existing = _with_retry(lambda: ws.get_all_records(numericise_ignore=['all']))
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
        _with_retry(lambda: ws.append_rows(to_add, value_input_option='RAW'))
    return len(to_add)


# ──────────────────────────────────────────────────────────
# 業務邏輯
# ──────────────────────────────────────────────────────────

def shares_at_date(trades: list, code: str, ex_date: str) -> float:
    """重播成交紀錄，計算除息日當天（含）持股數。side 為 'B' 買 / 'S' 賣"""
    total = 0.0
    for t in trades:
        if t['code'] != code:
            continue
        if t['date'] > ex_date:
            continue
        if t['side'] in ('B', 'BUY', '買', '買進'):
            total += t['qty']
        elif t['side'] in ('S', 'SELL', '賣', '賣出'):
            total -= t['qty']
    return max(total, 0.0)


def _yyyymmdd_to_iso(s: str) -> str:
    s = str(s).strip()
    if not s or s in ('--', '0', 'None'):
        return ''
    if '-' in s:
        return s[:10]
    if len(s) == 8 and s.isdigit():
        return f'{s[0:4]}-{s[4:6]}-{s[6:8]}'
    return s


def parse_ex_dividends(raw: dict, holding_codes: set) -> list:
    """過濾出持股代號 + 有現金股利的紀錄，正規化欄位"""
    rows = raw.get('data', {}).get('exDividends', [])
    out = []
    for r in rows:
        code = str(r.get('symbol', '')).strip()
        if code not in holding_codes:
            continue
        cps = r.get('cashDividendTotal') or 0
        if not cps:
            continue  # 只處理現金股利；純股票股利暫不計入
        ex_date = _yyyymmdd_to_iso(r.get('exDividendsDate', ''))
        if not ex_date:
            continue
        out.append({
            'code': code,
            'name': r.get('name', ''),
            'date': ex_date,
            'cps': float(cps),
            'pay_date': _yyyymmdd_to_iso(r.get('cashDividendsDate', '')),
        })
    return out


def build_dividend_rows(ex_div_list: list, trades: list, today: str = None) -> list:
    """套用「重播持股」與「status 判斷」，回傳可寫入 dividends_tw 的 row 清單（list of list）

    status 三態：
      upcoming  — 除息日未到（shares/amount 留空，前端用現有持股估算顯示）
      received  — 除息日已過且當時有持股（shares/amount 為確定值）
      cancelled — 除息日已過但除息前已清倉：不新增，且讓 sync 刪掉先前寫入的 upcoming 列
    """
    today = today or date.today().isoformat()
    rows = []
    for item in ex_div_list:
        is_future = item['date'] > today
        if is_future:
            shares_val = ''
            amount = ''
            status = 'upcoming'
        else:
            shares = shares_at_date(trades, item['code'], item['date'])
            if shares <= 0:
                log(f'  {item["code"]} {item["date"]}：除息前已無持股 → 標記 cancelled')
                shares_val = 0
                amount = 0
                status = 'cancelled'
            else:
                amount = round(shares * item['cps'], 2)
                status = 'received'
                shares_val = shares

        rows.append([
            item['date'], item['code'], item['name'], shares_val,
            item['cps'], amount, item['pay_date'], status,
        ])
    return rows


def sync_dividends(wb, ex_div_raw: dict):
    """主流程：讀 holdings/trades → 過濾解析 → 寫入 dividends_tw

    寫入策略（不再是純 append+dedup，否則 upcoming 列永遠凍結）：
      - (date, code) 不存在 → append（cancelled 除外）
      - 已存在且是 upcoming：
          新算出 received  → 原地更新該列（補上 shares/amount，狀態轉正）
          新算出 cancelled → 刪除該列（除息前已清倉，領不到）
      - 已存在且是 received → 不動（確定值不覆蓋）
    """
    holding_codes = read_holding_codes(wb)
    log(f'目前持股代號：{sorted(holding_codes)}')

    trades = read_trades(wb)
    log(f'讀取到 {len(trades)} 筆成交紀錄')

    ex_div_list = parse_ex_dividends(ex_div_raw, holding_codes)
    log(f'過濾後剩 {len(ex_div_list)} 筆持股相關除息資料')

    rows = build_dividend_rows(ex_div_list, trades)
    log(f'產生 {len(rows)} 筆待處理紀錄')

    ws = get_or_create_sheet(wb, 'dividends_tw', DIVIDENDS_HEADERS)
    all_vals = _with_retry(lambda: ws.get_all_values())
    st_i = DIVIDENDS_HEADERS.index('status')
    # (date, code) → (工作表列號 1-based, 現有 status)
    index = {}
    for i, r in enumerate(all_vals[1:], start=2):
        if len(r) >= 2 and r[0]:
            index[(r[0], str(r[1]).strip())] = (i, r[st_i].strip() if len(r) > st_i else '')

    to_append, to_delete = [], []
    updated = 0
    for row in rows:
        key = (row[0], str(row[1]))
        status_new = row[st_i]
        if key not in index:
            if status_new != 'cancelled':
                to_append.append(row)
            continue
        row_num, status_old = index[key]
        if status_old != 'upcoming':
            continue  # received 等確定狀態不覆蓋
        if status_new == 'received':
            _with_retry(lambda rn=row_num, rw=row: ws.update(
                values=[rw], range_name=f'A{rn}:H{rn}', value_input_option='RAW'))
            log(f'  ↻ {key[1]} {key[0]} upcoming → received（{row[3]}股, NT${row[5]}）')
            updated += 1
        elif status_new == 'cancelled':
            to_delete.append(row_num)
            log(f'  ✂ {key[1]} {key[0]} 除息前已清倉 → 刪除 upcoming 列')

    for rn in sorted(to_delete, reverse=True):   # 由下往上刪，避免列號位移
        _with_retry(lambda r=rn: ws.delete_rows(r))

    if to_append:
        _with_retry(lambda: ws.append_rows(to_append, value_input_option='RAW'))
    log(f'✓ dividends_tw 新增 {len(to_append)} 筆、轉正 {updated} 筆、刪除 {len(to_delete)} 筆')
    return len(to_append)


def migrate_historical_records(wb):
    """一次性遷移既有硬編碼的 20 筆歷史股利紀錄"""
    ws = get_or_create_sheet(wb, 'dividends_tw', DIVIDENDS_HEADERS)
    rows = []
    for r in HISTORICAL_RECORDS:
        amount = round(r['shares'] * r['cps'], 2)
        rows.append([r['date'], r['code'], r['name'], r['shares'], r['cps'], amount, '', 'received'])
    added = append_rows_dedup(ws, DIVIDENDS_HEADERS, rows, key_cols=['date', 'code'])
    log(f'✓ 歷史紀錄遷移：新增 {added} 筆（{len(rows) - added} 筆已存在，略過）')
    return added


if __name__ == '__main__':
    import sys
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

    gc = get_sheets_client()
    wb = gc.open(SPREADSHEET_NAME)
    log(f'已連線：{SPREADSHEET_NAME}')

    migrate_historical_records(wb)
