###############################################################
# backfill_20260706.py  （一次性補件）
# 7/6 sync 未執行 → prices_tw 缺一行、trades_tw 缺 6 筆成交。
# 本檔用 7/6 收盤後(14:52)下載的 xls 快照離線補齊，不碰 OneAPI。
#
#   dry-run（預設，只印不寫）:  python backfill_20260706.py
#   實際寫入:                   python backfill_20260706.py --commit
#
# 需用 arm64 python（pandas/numpy 在 32 位元壞掉）：
#   C:\Python311-arm64\python.exe backfill_20260706.py [--commit]
###############################################################

import sys
import warnings
from pathlib import Path

import pandas as pd
import gspread
from google.oauth2.service_account import Credentials

warnings.filterwarnings('ignore')

BASE = Path(__file__).parent
DATE = '2026-07-06'
# 7/6 TAIEX 收盤 = 7/7 tse_t00 的「昨收 y」= 46556.39（與 sync 用的 TWSE 來源一致）
TAIEX_CLOSE = 46556.39
SPREADSHEET_NAME = '投資日記'
CRED = str(BASE / 'gen-lang-client-0554604905-c721d97aaf28.json')
ETF_LIST = {'0050', '0056'}

COMMIT = '--commit' in sys.argv


def _num(x):
    """去掉逗號/百分比/正負號前綴，轉 float。"""
    s = str(x).replace(',', '').replace('%', '').replace('+', '').strip()
    return float(s)


def read_holdings():
    """未實現損益.xls → [{ticker, shares, price, mv, cost}]（7/6 收盤快照）"""
    t = pd.read_html(BASE / 'downloads' / '未實現損益.xls')[0]
    out = []
    for _, r in t.iloc[2:].iterrows():        # 跳過 2 列表頭
        code = str(r[1]).strip()
        if not code.isdigit():                # 略過合計/空列
            continue
        out.append({
            'ticker': code.zfill(4),
            'name':   str(r[2]).strip(),
            'shares': int(_num(r[4])),         # 庫存數量（含質押）
            'price':  _num(r[5]),              # 現價 = 7/6 收盤
            'mv':     _num(r[6]),              # 市值
            'cost':   _num(r[7]),              # 成本金額（已含質押部位）
        })
    return out


def read_trades():
    """投資明細.xls → 只取 7/6 成交，組成 trades_tw 列格式"""
    t = pd.read_html(BASE / 'downloads' / '投資明細.xls')[0]
    rows = []
    for _, r in t.iloc[2:].iterrows():
        d = str(r[0]).strip()
        if d != '2026/07/06':
            continue
        code = str(r[1]).zfill(4)
        name = str(r[2]).strip()
        side = str(r[4]).strip()               # 買/賣
        qty  = int(_num(r[6]))
        price = _num(r[7])
        deal_amt = qty * round(price, 2)
        fee = round(deal_amt * 0.001425 * 0.5887)     # 與 parse_trades 同公式
        tax = int(deal_amt * 0.003) if side == '賣' else 0
        rows.append([DATE, code, name, side, qty, round(price, 2),
                     fee, tax, '現股', '', '補件'])   # order_no 空、note=補件
    return rows


def build_price_row(holdings):
    total_mv   = round(sum(h['mv'] for h in holdings))
    total_cost = sum(h['cost'] for h in holdings)
    etf_mv     = sum(h['mv'] for h in holdings if h['ticker'] in ETF_LIST)
    stock_mv   = sum(h['mv'] for h in holdings) - etf_mv
    sell_fee   = sum(h['mv'] for h in holdings) * 0.001425
    sell_tax   = etf_mv * 0.001 + stock_mv * 0.003
    unrealized = round(sum(h['mv'] for h in holdings) - total_cost - sell_fee - sell_tax)
    return total_mv, unrealized


def main():
    print(f'=== 補件 {DATE}（{"實寫" if COMMIT else "DRY-RUN"}）===\n')

    holdings = read_holdings()
    trades   = read_trades()
    price_map = {h['ticker']: h['price'] for h in holdings}
    total_mv, unrealized = build_price_row(holdings)

    print(f'[未實現損益] 7/6 持股 {len(holdings)} 檔')
    print(f'  TOTAL_MV = {total_mv:,}   UNREALIZED = {unrealized:,}   TAIEX = {TAIEX_CLOSE}')
    print(f'[投資明細] 7/6 成交 {len(trades)} 筆:')
    for r in trades:
        print(f'    {r[1]} {r[2]} {r[3]} {r[4]} @ {r[5]}  fee={r[6]} tax={r[7]}')
    print()

    gc = gspread.authorize(Credentials.from_service_account_file(
        CRED, scopes=['https://www.googleapis.com/auth/spreadsheets',
                      'https://www.googleapis.com/auth/drive']))
    wb = gc.open(SPREADSHEET_NAME)

    # ── prices_tw ──
    ws = wb.worksheet('prices_tw')
    data = ws.get_all_values()
    header = data[0]
    if any(r[0] == DATE for r in data[1:]):
        print(f'[prices_tw] {DATE} 已存在，跳過')
    else:
        # header 只增不減：補上 7/6 有、header 沒有的新代號
        tail = ['TAIEX', 'TOTAL_MV', 'UNREALIZED', 'UNREALIZED_YUANTA']
        existing_tickers = [c for c in header if c not in ({'date'} | set(tail))]
        new_tickers = [t for t in price_map if t not in existing_tickers]
        merged = existing_tickers + sorted(new_tickers)
        new_header = ['date'] + merged + tail
        row = [DATE] + [price_map.get(t, '') for t in merged] + \
              [TAIEX_CLOSE, total_mv, unrealized, '']
        print(f'[prices_tw] 將新增 1 列（{len(merged)} 檔欄位' +
              (f'，新增代號 {new_tickers}' if new_tickers else '') + '）')
        if COMMIT:
            if new_header != header:
                # header 變動 → 重排既有列對齊
                idx = {c: i for i, c in enumerate(header)}
                realigned = [[(r[idx[c]] if c in idx and idx[c] < len(r) else '')
                              for c in new_header] for r in data[1:]]
                ws.clear()
                ws.append_row(new_header, value_input_option='RAW')
                if realigned:
                    ws.append_rows(realigned, value_input_option='RAW')
            ws.append_row(row, value_input_option='RAW')
            # 降冪排序
            alld = ws.get_all_values()
            hdr, body = alld[0], sorted(alld[1:], key=lambda r: r[0], reverse=True)
            ws.clear()
            ws.append_row(hdr, value_input_option='RAW')
            ws.append_rows(body, value_input_option='RAW')
            print('  ✓ prices_tw 已寫入並排序')

    # ── trades_tw ──
    wt = wb.worksheet('trades_tw')
    thdr = wt.get_all_values()[0]
    key_cols = ['date', 'code', 'side', 'qty', 'order_no']
    existing = wt.get_all_records()
    exist_keys = {tuple(str(r.get(c, '')) for c in key_cols) for r in existing}
    to_add = []
    for r in trades:
        k = tuple(str(r[thdr.index(c)]) for c in key_cols)
        if k not in exist_keys:
            to_add.append(r); exist_keys.add(k)
    print(f'[trades_tw] 去重後將新增 {len(to_add)} 筆（原 {len(trades)} 筆）')
    if COMMIT and to_add:
        wt.append_rows(to_add, value_input_option='USER_ENTERED')
        allt = wt.get_all_values()
        hdr, body = allt[0], sorted(allt[1:], key=lambda r: r[0], reverse=True)
        wt.clear()
        wt.append_row(hdr, value_input_option='RAW')
        wt.append_rows(body, value_input_option='USER_ENTERED')
        print('  ✓ trades_tw 已寫入並排序')

    print('\n' + ('完成！' if COMMIT else '（DRY-RUN，未寫入。加 --commit 才會真正寫入）'))


if __name__ == '__main__':
    main()
