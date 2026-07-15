"""
yuanta_unrealized.py  v1.0
每個工作日執行：解析元大「未實現損益.xls」，把總市值和總損益寫入 prices_tw

使用方式：
    python yuanta_unrealized.py        # 解析 downloads 資料夾最新的 xls
"""

import os
import re
import sys
import ssl
import datetime
from pathlib import Path

import certifi
os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()
os.environ['SSL_CERT_FILE']      = certifi.where()
ssl._create_default_https_context = ssl.create_default_context

import gspread
from google.oauth2.service_account import Credentials

# ══════════════════════════════════════════════════════════
# 設定
# ══════════════════════════════════════════════════════════
BASE_DIR         = Path(__file__).parent
CREDENTIALS_FILE = BASE_DIR / 'gen-lang-client-0554604905-c721d97aaf28.json'
SPREADSHEET_NAME = '投資日記'
DOWNLOAD_DIR     = BASE_DIR / 'downloads'


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
# Step 1：解析未實現損益 xls
# ══════════════════════════════════════════════════════════
def parse_unrealized(xls_path: Path) -> tuple:
    """
    從元大未實現損益 xls 讀取總市值和總損益
    回傳 (total_mv, total_unrealized) 整數
    """
    print(f'\n[1] 解析 {xls_path.name}...')

    content = xls_path.read_text(encoding='utf-8', errors='ignore')

    def extract_id(element_id):
        pattern = rf'id="{element_id}"[^>]*>([^<]+)<'
        m = re.search(pattern, content)
        if m:
            val = m.group(1).strip().replace(',', '').replace('+', '').replace('NT$', '')
            try:
                return int(float(val))
            except ValueError:
                return None
        return None

    total_mv          = extract_id('divTotalValue_TWD')
    total_unrealized  = extract_id('divTotalProfit_TWD')

    if total_mv is None or total_unrealized is None:
        # 備用：用 regex 直接搜尋
        mv_m = re.search(r'總市值:.*?<span[^>]*>([\d,]+)</span>', content)
        pnl_m = re.search(r'總損益:.*?<span[^>]*>([+\-][\d,]+)</span>', content)
        if mv_m:
            total_mv = int(mv_m.group(1).replace(',', ''))
        if pnl_m:
            total_unrealized = int(pnl_m.group(1).replace(',', '').replace('+', ''))

    print(f'  總市值:     {total_mv:,}')
    print(f'  總損益:     {total_unrealized:,}')
    return total_mv, total_unrealized


# ══════════════════════════════════════════════════════════
# Step 2：寫入 prices_tw
# ══════════════════════════════════════════════════════════
def write_to_prices_tw(total_mv: int, total_unrealized: int):
    print(f'\n[2] 寫入 prices_tw...')

    today = datetime.date.today().strftime('%Y-%m-%d')

    gc = get_sheets_client()
    wb = gc.open(SPREADSHEET_NAME)
    ws = wb.worksheet('prices_tw')

    all_data = ws.get_all_values()
    if not all_data:
        print('  [錯誤] prices_tw 無資料')
        return

    header = all_data[0]

    # 確保 UNREALIZED_YUANTA 欄位存在（若不存在則新增在最後）
    if 'UNREALIZED_YUANTA' not in header:
        new_col = len(header) + 1  # 最後一欄的下一欄（1-based）
        ws.update_cell(1, new_col, 'UNREALIZED_YUANTA')
        print(f'  ✓ 新增欄位 UNREALIZED_YUANTA 在第 {new_col} 欄')
        # 重新讀取 header
        header = ws.row_values(1)

    col_yuanta = header.index('UNREALIZED_YUANTA') + 1  # 1-based

    # 找今天的行
    target_row = None
    for i, row in enumerate(all_data[1:], start=2):
        if row[0].strip() == today:
            target_row = i
            break

    if target_row is None:
        print(f'  [錯誤] prices_tw 找不到今天 {today} 的資料')
        print(f'  請確認 yuanta_sync.py 已在今天執行過')
        return

    from gspread.utils import rowcol_to_a1
    yuanta_cell = rowcol_to_a1(target_row, col_yuanta)
    formatted_value = f'NT${total_unrealized:,}'
    ws.update([[formatted_value]], yuanta_cell, value_input_option='USER_ENTERED')

    # 同時顯示與公式算的差異
    if 'UNREALIZED' in header:
        col_formula = header.index('UNREALIZED') + 1
        formula_cell = rowcol_to_a1(target_row, col_formula)
        formula_val = ws.cell(target_row, col_formula).value
        try:
            formula_int = int(str(formula_val).replace(',', '').replace('NT$', '').strip())
            diff = total_unrealized - formula_int
            print(f'  公式損益:   {formula_int:,}')
            print(f'  元大損益:   {total_unrealized:,}')
            print(f'  差異:       {diff:+,}')
        except Exception:
            pass

    print(f'  ✓ {today}  UNREALIZED_YUANTA=NT${total_unrealized:,}  已寫入第 {target_row} 行')


# ══════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════
def main():
    print('=' * 60)
    print('yuanta_unrealized.py  v1.0')
    print('=' * 60)

    # 找最新的未實現損益 xls
    candidates = sorted(
        [f for f in DOWNLOAD_DIR.glob('未實現損益*.xls*') if f.suffix != '.crdownload'],
        key=lambda f: f.stat().st_mtime,
        reverse=True
    )

    if not candidates:
        # 找任何最新的 xls
        candidates = sorted(
            [f for f in DOWNLOAD_DIR.glob('*.xls*') if f.suffix != '.crdownload'],
            key=lambda f: f.stat().st_mtime,
            reverse=True
        )
        if not candidates:
            print(f'[錯誤] downloads 資料夾找不到 xls 檔案')
            sys.exit(1)

    xls_path = candidates[0]
    print(f'  使用檔案: {xls_path.name}')

    total_mv, total_unrealized = parse_unrealized(xls_path)

    if total_mv is None or total_unrealized is None:
        print('[錯誤] 無法解析總市值或總損益')
        sys.exit(1)

    write_to_prices_tw(total_mv, total_unrealized)

    print('\n✅ 完成！')


if __name__ == '__main__':
    main()
