###############################################################
# yuanta_prices_backfill.py
# prices_tw 補洞：把漏掉的交易日補回去。
#
# 為什麼需要：write_prices_tw() 只寫「今天」，而且今天已存在就跳過 ——
# 一旦某天排程沒跑（例如 2026-09-03 那次 principal 全滅），那一天就永久空白，
# 沒有任何機制會回頭補。這支補的就是那個缺口。
#
# 能重建什麼：
#   個股收盤價、TAIEX、TOTAL_MV、UNREALIZED  → 可以。價格以證交所為準、Yahoo 備援（上櫃股票
#                                             走 Yahoo，因為證交所 API 只涵蓋上市），
#                                             兩邊都有就比對；總額公式與主腳本完全一致。
#   UNREALIZED_YUANTA                       → 不行。那是元大官方未實現損益，
#                                             來自當天下載的 xls，事後拿不到，留空。
#
# 前提（腳本會自己檢查，不成立就中止）：
#   目標日之後到今天之間 trades_tw 沒有任何成交 —— 否則當時的持股數與成本
#   跟現在不同，用現在的 holdings_tw 回推會算錯。
#
# 用法：
#   python yuanta_prices_backfill.py --verify 2026-09-04     # 用已知正確的一天反算，驗證公式
#   python yuanta_prices_backfill.py --date 2026-09-03       # dry-run，只印不寫
#   python yuanta_prices_backfill.py --date 2026-09-03 --commit
#   python yuanta_prices_backfill.py --scan 10               # 掃最近 10 天有沒有洞（dry-run）
###############################################################

import argparse
import datetime
import json
import os
import re
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import certifi
os.environ['REQUESTS_CA_BUNDLE'] = certifi.where()
os.environ['SSL_CERT_FILE'] = certifi.where()
ssl._create_default_https_context = ssl.create_default_context

import gspread
from google.oauth2.service_account import Credentials

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

BASE_DIR         = Path(__file__).parent
CREDENTIALS_FILE = BASE_DIR / 'gen-lang-client-0554604905-c721d97aaf28.json'
SPREADSHEET_NAME = '投資日記'

TAIL_COLS = ['TAIEX', 'TOTAL_MV', 'UNREALIZED', 'UNREALIZED_YUANTA']
ETF_LIST  = {'0050', '0056'}          # 與 yuanta_sync.py 一致：ETF 證交稅 0.1%，個股 0.3%
FEE_RATE  = 0.001425
TAX_ETF   = 0.001
TAX_STOCK = 0.003


def get_client():
    scopes = ['https://www.googleapis.com/auth/spreadsheets',
              'https://www.googleapis.com/auth/drive']
    return gspread.authorize(Credentials.from_service_account_file(str(CREDENTIALS_FILE), scopes=scopes))


def _num(v):
    """把 'NT$668,112' / '-NT$3,170' / '107.9' 這類字串轉成數字。"""
    if v is None:
        return 0.0
    s = str(v).strip().replace('NT$', '').replace(',', '').replace('$', '')
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def load_holdings(wb):
    """讀 holdings_tw，回傳 {ticker: {shares, lent_shares, cost}}。ticker 補到 4 碼。"""
    vals = wb.worksheet('holdings_tw').get_all_values()
    hdr  = vals[0]
    idx  = {c: i for i, c in enumerate(hdr)}
    out  = {}
    for row in vals[1:]:
        if not row or not row[idx['ticker']].strip():
            continue
        tk = row[idx['ticker']].strip()
        tk = tk.zfill(4) if re.match(r'^\d{1,3}$', tk) else tk
        shares = _num(row[idx['shares']])
        lent   = _num(row[idx['lent_shares']]) if 'lent_shares' in idx else 0.0
        cost   = _num(row[idx['cost']])
        if shares + lent <= 0:
            continue
        out[tk] = {'shares': shares, 'lent_shares': lent, 'cost': cost}
    return out


def last_trade_date(wb):
    vals = wb.worksheet('trades_tw').get_all_values()
    di   = vals[0].index('date')
    dates = [r[di].strip() for r in vals[1:] if len(r) > di and r[di].strip()]
    return max(dates) if dates else ''


def yahoo_close(symbol, date_str):
    """抓某一天的收盤價；沒有該日資料回 None。"""
    d  = datetime.date.fromisoformat(date_str)
    p1 = int(datetime.datetime(d.year, d.month, d.day).timestamp()) - 86400 * 2
    p2 = p1 + 86400 * 5
    url = ('https://query1.finance.yahoo.com/v8/finance/chart/' + urllib.parse.quote(symbol) +
           f'?interval=1d&period1={p1}&period2={p2}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f'    [warn] {symbol} 抓取失敗：{e}')
        return None
    res = (data.get('chart') or {}).get('result') or []
    if not res:
        return None
    ts     = res[0].get('timestamp') or []
    closes = ((res[0].get('indicators') or {}).get('quote') or [{}])[0].get('close') or []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        # 台股日 K 的時間戳是當日開盤（台北時間），用台北日期比對
        day = datetime.datetime.utcfromtimestamp(t + 8 * 3600).strftime('%Y-%m-%d')
        if day == date_str:
            return round(float(c), 4)
    return None


_TWSE_CACHE = {}


def twse_month(stock, date_str):
    """抓證交所某檔某月的日成交資訊，回傳 {yyyy-mm-dd: close}。上櫃股票會回 None。"""
    key = (stock, date_str[:7])
    if key in _TWSE_CACHE:
        return _TWSE_CACHE[key]
    ym  = date_str[:7].replace('-', '') + '01'
    url = ('https://www.twse.com.tw/exchangeReport/STOCK_DAY'
           f'?response=json&date={ym}&stockNo={stock}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    result = None
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=20).read())
        if d.get('stat') == 'OK':
            result = {}
            for row in d.get('data', []):
                # 日期是民國年，如 115/09/03
                y, m, dd = row[0].split('/')
                iso = f'{int(y) + 1911:04d}-{int(m):02d}-{int(dd):02d}'
                px = _num(row[6])
                if px:
                    result[iso] = px
    except Exception as e:
        print(f'    [warn] TWSE {stock} 抓取失敗：{e}')
    _TWSE_CACHE[key] = result
    time.sleep(1.2)          # 證交所會擋太密集的請求
    return result


def twse_taiex(date_str):
    ym  = date_str[:7].replace('-', '') + '01'
    url = f'https://www.twse.com.tw/indicesReport/MI_5MINS_HIST?response=json&date={ym}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        d = json.loads(urllib.request.urlopen(req, timeout=20).read())
        if d.get('stat') == 'OK':
            for row in d.get('data', []):
                y, m, dd = row[0].split('/')
                if f'{int(y) + 1911:04d}-{int(m):02d}-{int(dd):02d}' == date_str:
                    return _num(row[4])      # 收盤指數
    except Exception as e:
        print(f'    [warn] TWSE 大盤抓取失敗：{e}')
    return None


def fetch_prices(tickers, date_str):
    """證交所優先（權威來源），Yahoo 備援（上櫃股票、或證交所缺資料時）。
    兩邊都有就比對 —— 不一致要讓人看見，不能默默選一個。"""
    out, mismatch = {}, []
    for tk in tickers:
        official = None
        month = twse_month(tk, date_str)
        if month is not None:
            official = month.get(date_str)

        y = yahoo_close(f'{tk}.TW', date_str)
        if y is None:
            y = yahoo_close(f'{tk}.TWO', date_str)

        if official is not None and y is not None and abs(official - y) > 0.01:
            mismatch.append((tk, official, y))

        px  = official if official is not None else y
        src = 'TWSE' if official is not None else ('Yahoo' if y is not None else '')
        if px is None:
            print(f'    [warn] {tk} 在 {date_str} 證交所與 Yahoo 都沒有資料')
            continue
        out[tk] = px
        print(f'    {tk}  {src:5s} {px}')

    if mismatch:
        print('\n    [!!] 證交所與 Yahoo 不一致（採用證交所）：')
        for tk, o, y in mismatch:
            print(f'         {tk}  TWSE={o}  Yahoo={y}')
    return out


def compute_totals(holdings, price_map):
    """與 yuanta_sync.py 的 write_prices_tw 完全相同的算法。"""
    total_mv = sum((h['shares'] + h['lent_shares']) * price_map[t]
                   for t, h in holdings.items() if t in price_map)
    total_cost = sum(h['cost'] for t, h in holdings.items() if t in price_map)
    etf_mv = sum((h['shares'] + h['lent_shares']) * price_map[t]
                 for t, h in holdings.items() if t in price_map and t in ETF_LIST)
    stock_mv = total_mv - etf_mv
    sell_fee = total_mv * FEE_RATE
    sell_tax = etf_mv * TAX_ETF + stock_mv * TAX_STOCK
    unrealized = round(total_mv - total_cost - sell_fee - sell_tax)
    return round(total_mv), unrealized, total_cost


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', help='要補的日期 yyyy-mm-dd')
    ap.add_argument('--verify', help='用已存在的某天反算，驗證公式是否吻合')
    ap.add_argument('--scan', type=int, metavar='N', help='掃最近 N 天有沒有洞')
    ap.add_argument('--commit', action='store_true', help='真的寫入（預設 dry-run）')
    args = ap.parse_args()

    if not (args.date or args.verify or args.scan):
        ap.error('至少要給 --date / --verify / --scan 其中一個')

    wb = get_client().open(SPREADSHEET_NAME)
    ws = wb.worksheet('prices_tw')
    all_vals = ws.get_all_values()
    header   = all_vals[0]
    existing = {r[0]: r for r in all_vals[1:] if r and r[0].strip()}
    stock_cols = [c for c in header[1:] if c not in TAIL_COLS]

    # ── 掃洞 ──
    if args.scan:
        # 平日不等於交易日 —— 用 2330 向證交所探針確認那天有沒有開市，
        # 否則每逢國定假日都會誤報。一次請求涵蓋整個月，所以很便宜。
        today = datetime.date.today()
        print(f'掃描最近 {args.scan} 天：')
        holes = []
        for i in range(1, args.scan + 1):
            d = today - datetime.timedelta(days=i)
            if d.weekday() >= 5:
                continue
            ds = d.isoformat()
            wd = '一二三四五六日'[d.weekday()]
            if ds in existing:
                print(f'  {ds} ({wd})  有')
                continue
            month = twse_month('2330', ds)
            if month is None:
                print(f'  {ds} ({wd})  缺，但證交所查不到 —— 無法判斷')
                continue
            if ds not in month:
                print(f'  {ds} ({wd})  非交易日')
                continue
            holes.append(ds)
            print(f'  {ds} ({wd})  ** 缺（該日有開市）**')
        if holes:
            print('\n缺口：' + ', '.join(holes))
            print('補法：python yuanta_prices_backfill.py --date <日期> --commit')
        else:
            print('\n沒有缺口。')
        return len(holes)          # 結束碼＝真正的缺口數，供守望腳本判讀

    holdings = load_holdings(wb)
    print(f'holdings_tw：{len(holdings)} 檔有部位')

    # ── 驗證模式：用已知正確的一天反算 ──
    if args.verify:
        d = args.verify
        if d not in existing:
            print(f'[錯誤] prices_tw 沒有 {d} 這一列')
            return 1
        row = existing[d]
        pm = {}
        for i, c in enumerate(header):
            if c in stock_cols and i < len(row) and str(row[i]).strip():
                pm[c] = _num(row[i])
        mv, un, cost = compute_totals(holdings, pm)
        want_mv = _num(row[header.index('TOTAL_MV')])
        want_un = _num(row[header.index('UNREALIZED')])
        print(f'\n驗證 {d}（用表上既有價格反算）：')
        print(f'  TOTAL_MV    算出 {mv:>12,}   表上 {int(want_mv):>12,}   差 {mv - int(want_mv):+,}')
        print(f'  UNREALIZED  算出 {un:>12,}   表上 {int(want_un):>12,}   差 {un - int(want_un):+,}')
        print(f'  （總成本 {int(cost):,}）')
        ok = mv == int(want_mv) and un == int(want_un)
        print('\n' + ('✅ 公式吻合，可以信任補件結果' if ok else
                      '❌ 公式對不上 —— 不要用這支補件，先查為什麼'))
        return 0 if ok else 1

    # ── 補件 ──
    date_str = args.date
    if date_str in existing:
        print(f'[跳過] {date_str} 已存在，不覆蓋')
        return 0

    lt = last_trade_date(wb)
    print(f'trades_tw 最後成交日：{lt}')
    if lt and lt > date_str:
        print(f'[中止] {date_str} 之後還有成交（{lt}）—— 當時的持股數與成本跟現在不同，')
        print('       用現在的 holdings_tw 回推會算錯。需要改用重播 trades_tw 的方式。')
        return 1
    print('  ✓ 目標日之後沒有成交，可用現在的持倉回推\n')

    held = [t for t in stock_cols if t in holdings]
    print(f'抓 {date_str} 收盤價（{len(held)} 檔）：')
    price_map = fetch_prices(held, date_str)
    if not price_map:
        print(f'\n[中止] {date_str} 一檔都沒抓到 —— 可能不是台股交易日')
        return 1
    missing = [t for t in held if t not in price_map]
    if missing:
        print(f'\n[中止] 這些沒抓到：{missing}')
        print('       少一檔市值就會算錯，寧可不寫。')
        return 1

    taiex = twse_taiex(date_str)
    if taiex is None:
        taiex = yahoo_close('^TWII', date_str)
        print(f'  TAIEX {taiex}  (Yahoo 備援)')
    else:
        print(f'  TAIEX {taiex}  (TWSE)')

    mv, un, cost = compute_totals(holdings, price_map)
    print(f'\n{date_str} 重建結果：')
    print(f'  TOTAL_MV           {mv:>12,}')
    print(f'  UNREALIZED         {un:>12,}   （總成本 {int(cost):,}）')
    print(f'  TAIEX              {taiex}')
    print(f'  UNREALIZED_YUANTA  (留空 —— 元大官方數字事後拿不回來)')

    row = [date_str]
    for c in stock_cols:
        row.append(price_map.get(c, ''))
    row += [taiex if taiex is not None else '', mv, un, '']

    if not args.commit:
        print('\nDRY RUN —— 沒有寫入。確認以上數字後加 --commit 再跑一次。')
        return 0

    ws.append_row(row, value_input_option='RAW')
    print(f'\n✓ 已寫入 {date_str}')

    data = ws.get_all_values()
    if len(data) > 2:
        hdr_row = data[0]
        body = sorted(data[1:], key=lambda r: r[0], reverse=True)
        ws.clear()
        ws.append_row(hdr_row, value_input_option='RAW')
        ws.append_rows(body, value_input_option='RAW')
        print(f'✓ 降冪排序完成（{len(body)} 列）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
