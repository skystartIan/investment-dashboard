"""
yuanta_web_dca.py  v2.0
由 Claude in Chrome Routine 負責登入和下載，本腳本只負責解析 xls 並寫入 trades_tw

使用方式：
    python yuanta_web_dca.py              # 解析 downloads 資料夾最新的 xls
    python yuanta_web_dca.py 2026-04      # 指定月份（僅用於過濾，一般不需要）

依賴：
    pip install pandas xlrd gspread google-auth certifi
"""

import os
import sys
import datetime
import ssl
from pathlib import Path

import certifi
os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()
os.environ['SSL_CERT_FILE']      = certifi.where()
ssl._create_default_https_context = ssl.create_default_context

import pandas as pd
import gspread
from google.oauth2.service_account import Credentials

# ══════════════════════════════════════════════════════════
# 設定
# ══════════════════════════════════════════════════════════
BASE_DIR         = Path(__file__).parent
CREDENTIALS_FILE = BASE_DIR / 'gen-lang-client-0554604905-c721d97aaf28.json'
SPREADSHEET_NAME = '投資日記'
DOWNLOAD_DIR     = BASE_DIR / 'downloads'
DOWNLOAD_DIR.mkdir(exist_ok=True)


# ══════════════════════════════════════════════════════════
# Google Sheets
# ══════════════════════════════════════════════════════════
def get_sheets_client():
    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive',
    ]
    creds = Credentials.from_service_account_file(str(CREDENTIALS_FILE), scopes=scopes)
    return gspread.authorize(creds)


# ══════════════════════════════════════════════════════════
# Step 1：解析 xls，找出定期定額
# ══════════════════════════════════════════════════════════
def parse_dca_trades(xls_path: Path) -> list:
    print(f'\n[1] 解析 {xls_path.name}...')

    try:
        tables = pd.read_html(str(xls_path), encoding='utf-8', header=None)
    except Exception:
        tables = pd.read_html(str(xls_path), encoding='big5', header=None)

    print(f'  找到 {len(tables)} 個表格')

    dca_trades = []
    for df in tables:
        df = df.astype(str)
        # 第0行是合併標題，第1行是欄位名稱，第2行起是資料
        df.columns = df.iloc[1]
        df = df.iloc[2:].reset_index(drop=True)

        # 找「定期定額」的行
        mask = df.apply(lambda col: col.str.contains('定期定額', na=False)).any(axis=1)
        dca_rows = df[mask]
        if len(dca_rows) == 0:
            continue

        print(f'  找到 {len(dca_rows)} 筆定期定額')
        for _, row in dca_rows.iterrows():
            trade = _parse_row(row)
            if trade:
                dca_trades.append(trade)

    print(f'  共解析出 {len(dca_trades)} 筆定期定額')
    return dca_trades


def _parse_row(row) -> dict:
    try:
        def get(*keys):
            for k in keys:
                if k in row.index:
                    val = str(row[k]).strip()
                    if val and val not in ('nan', 'None', '--', ''):
                        return val
            return ''

        def to_float(s):
            return float(str(s).replace(',', '').replace('$', '').replace('NT', '').strip() or 0)

        # 成交日期
        date_raw = get('成交日期')
        if not date_raw:
            return None
        date_str = date_raw.replace('/', '-')

        # 股票代號
        code_raw = get('代號')
        if not code_raw:
            return None
        code = str(code_raw).strip().lstrip("'").zfill(4)

        name     = get('名稱')
        side_raw = get('買 賣', '買賣')
        side     = '買' if '買' in side_raw else '賣'
        # qty/fee/tax 必須是 int：float 會讓去重 key 變成 "182.0"，
        # 與 sheet 讀回的 int "182" 永遠不相等 → 每跑一次就重複寫一次
        qty      = int(to_float(get('數量')))
        price    = to_float(get('單價'))
        fee_raw  = get('手續費')
        fee      = int(to_float(fee_raw)) if fee_raw else 1
        tax_raw  = get('交易稅')
        tax      = int(to_float(tax_raw)) if tax_raw else 0

        return {
            'date':       date_str,
            'code':       code,
            'name':       name,
            'side':       side,
            'qty':        qty,
            'price':      price,
            'fee':        fee,
            'tax':        tax,
            'trade_type': '定期定額',
            'order_no':   '',
            'note':       '',
        }
    except Exception as e:
        print(f'  [略過] 解析失敗: {e}')
        return None


# ══════════════════════════════════════════════════════════
# Step 2：寫入 trades_tw（去重複）
# ══════════════════════════════════════════════════════════
def write_to_trades_tw(trades: list):
    if not trades:
        print('\n[2] 沒有新的定期定額需要寫入')
        return

    print(f'\n[2] 寫入 {len(trades)} 筆到 trades_tw...')
    gc = get_sheets_client()
    wb = gc.open(SPREADSHEET_NAME)
    ws = wb.worksheet('trades_tw')

    existing = ws.get_all_records()
    existing_keys = {
        f"{r.get('date','')}-{str(r.get('code','')).zfill(4)}-{r.get('side','')}-{r.get('qty','')}-{r.get('trade_type','')}"
        for r in existing
    }

    header = ws.row_values(1)
    new_rows = []
    for t in trades:
        key = f"{t['date']}-{t['code']}-{t['side']}-{t['qty']}-{t['trade_type']}"
        if key in existing_keys:
            print(f"  [跳過] 已存在: {t['date']} {t['code']} {t['qty']}股")
            continue
        row = [t.get(h, '') for h in header]
        if 'code' in header:
            # USER_ENTERED 會把 "0050" 轉成數字 50，加 ' 前綴保留前導零
            row[header.index('code')] = "'" + t['code']
        new_rows.append(row)
        print(f"  + {t['date']} {t['code']} {t['name']} {t['side']} {t['qty']}股 @{t['price']} 手續費{t['fee']}")

    if not new_rows:
        print('  全部已存在，無需新增')
        return

    ws.append_rows(new_rows, value_input_option='USER_ENTERED')
    print(f'  ✓ 成功新增 {len(new_rows)} 筆')

    # 降冪排序
    all_data = ws.get_all_values()
    if len(all_data) > 2:
        header_row = all_data[0]
        data_rows  = sorted(all_data[1:], key=lambda r: r[0], reverse=True)
        ws.update([header_row] + data_rows, value_input_option='USER_ENTERED')
        print(f'  ✓ 降冪排序完成（{len(data_rows)} 筆）')


# ══════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════
def main():
    print('=' * 60)
    print(f'yuanta_web_dca.py  v2.0')
    print('=' * 60)

    # 每天都跑：去重會擋掉已存在的紀錄，天天解析本月明細是冪等操作。
    # 不設日期窗口 — 之前「只在 8-12 號執行」導致 DCA 順延到 13 號時被跳過（2026-07-13）

    # 只認投資明細（*.xls* 會抓到較晚下載的未實現損益.xls，解析錯檔案）
    files = sorted(
        [f for f in DOWNLOAD_DIR.glob('投資明細*.xls*') if f.suffix != '.crdownload'],
        key=lambda f: f.stat().st_mtime,
        reverse=True
    )
    if not files:
        print(f'[錯誤] downloads 資料夾找不到 xls 檔案: {DOWNLOAD_DIR}')
        sys.exit(1)

    xls_path = files[0]
    print(f'  使用檔案: {xls_path.name}')

    trades = parse_dca_trades(xls_path)
    write_to_trades_tw(trades)

    print('\n✅ 完成！')


if __name__ == '__main__':
    main()
