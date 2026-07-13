"""
yuanta_dividend_fetch.py  v0.1 (測試階段，獨立腳本，不掛在每日排程)

目的：登入元大 NexusWebTrade，呼叫除權除息表底層 API (GetExDividends)，
      印出/存檔 raw JSON 以確認欄位結構，再用 holdings_tw 持股代號過濾。

此腳本複製貼上 yuanta_login_playwright.py 的登入邏輯（不 import 主腳本，
避免互相影響），驗證通過後才會把抓取邏輯整理進主流程。

使用方式：
    python yuanta_dividend_fetch.py
"""

import json
import os
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

BASE_DIR = Path(__file__).parent

CHROME_PATHS = [
    Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe'),
    Path(r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'),
]

USER_DATA_DIR = Path(os.environ.get(
    'YUANTA_CHROME_PROFILE',
    str(BASE_DIR / 'chrome_profile')))
PROFILE_DIR = os.environ.get('YUANTA_CHROME_PROFILE_DIR', 'Default')
HEADLESS = os.environ.get('YUANTA_HEADLESS', '0') == '1'

LOGIN_URL = 'https://global.yuanta.com.tw/NexusWebTrade/Login/OtpLogin'
TRANS_URL = 'https://global.yuanta.com.tw/NexusWebTrade/nexuswebtrade/trans'
EXDIV_API = 'https://global.yuanta.com.tw/NexusWebTrade/GetExDividends'
EXDIV_PARAMS = {'mainOption': '0', 'secondOption': 'RecentExDividendStocks'}

CONFIG_SERVER = 'http://localhost:8765'


def load_env():
    env_path = BASE_DIR / '.env'
    if env_path.exists():
        for line in env_path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ[k.strip()] = v.strip()


load_env()
WEB_ID = os.environ.get('YUANTA_WEB_ID', '')
PASSWORD = os.environ.get('YUANTA_PASSWORD', '')
ANTHROPIC_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

if not WEB_ID or not PASSWORD:
    print('❌ .env 缺少 YUANTA_WEB_ID 或 YUANTA_PASSWORD，請補齊後再執行')
    sys.exit(1)


def log(msg: str):
    print(f'[股利抓取測試] {msg}')


def wait_url_leaves(page, substr: str, timeout: int = 30) -> str:
    substr = substr.lower()
    page.wait_for_url(lambda url: substr not in url.lower(), timeout=timeout * 1000)
    return page.url


def click_button_by_text(page, text: str, label: str = None, visible_only: bool = False) -> bool:
    for btn in page.locator('button').all():
        try:
            if visible_only and not btn.is_visible():
                continue
            if btn.inner_text().strip() == text:
                btn.click()
                log(label or f'點擊「{text}」')
                time.sleep(1)
                return True
        except Exception:
            continue
    return False


def fill_input(page, selector: str, value: str):
    page.evaluate(
        """({selector, value}) => {
            const el = document.querySelector(selector);
            if (!el) return;
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(el, value);
            el.dispatchEvent(new Event('input',  { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur',   { bubbles: true }));
        }""",
        {'selector': selector, 'value': value},
    )


# ──────────────────────────────────────────────────────────
# CAPTCHA（與 yuanta_login_playwright.py 相同邏輯）
# ──────────────────────────────────────────────────────────

import base64
import re
import requests as req_lib


def solve_captcha_claude(question: str, images: list) -> list:
    log(f'呼叫 Claude API 判斷 CAPTCHA: {question}')
    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

    content = [
        {
            'type': 'text',
            'text': (
                f'你是圖片辨識專家。題目是：{question}\n\n'
                '以下每張圖片都有對應的 id，請仔細辨識每張圖片的內容'
                '（注意：圖片可能是插圖、卡通、圖示風格），判斷哪些圖片符合題目要求。\n\n'
                '重要：只回傳 JSON 格式，不要有任何其他文字或 markdown：'
                '{"correct_ids": ["id1", "id2"]}'
            ),
        }
    ]
    for img in images:
        content.append({'type': 'text', 'text': f'圖片 id={img["id"]}:'})
        content.append({
            'type': 'image',
            'source': {
                'type': 'base64',
                'media_type': img['content_type'],
                'data': img['base64'],
            },
        })

    resp = client.messages.create(
        model='claude-haiku-4-5-20251001',
        max_tokens=200,
        messages=[{'role': 'user', 'content': content}],
    )
    text = resp.content[0].text.strip()
    text = text.replace('```json', '').replace('```', '').strip()
    parsed = json.loads(text[text.index('{'):text.rindex('}') + 1])
    return parsed.get('correct_ids', [])


def lookup_captcha_db(images: list) -> dict:
    try:
        payload = {'images': [{'id': img['id'], 'b64': img['base64']} for img in images]}
        r = req_lib.post(f'{CONFIG_SERVER}/captcha/lookup', json=payload, timeout=5)
        return r.json().get('results', {})
    except Exception:
        return {}


def save_captcha_db(images: list, label: str):
    try:
        payload = {
            'images': [
                {'b64': img['base64'], 'hashes': img.get('hashes', {}), 'label': label}
                for img in images
            ]
        }
        req_lib.post(f'{CONFIG_SERVER}/captcha/save', json=payload, timeout=5)
    except Exception:
        pass


def resolve_captcha(question: str, images: list) -> list:
    m = re.search(r'【(.+?)】', question)
    target_label = m.group(1) if m else None
    log(f'目標類別: {target_label}')

    db_results = lookup_captcha_db(images)
    for img in images:
        if img['id'] in db_results:
            img['hashes'] = db_results[img['id']].get('hashes', {})
            img['label'] = db_results[img['id']].get('label')

    if target_label:
        all_known = all(img.get('label') is not None for img in images)
        if all_known:
            correct_ids = [img['id'] for img in images if img.get('label') == target_label]
            if correct_ids:
                log('✅ 資料庫命中！')
                return correct_ids

    correct_ids = solve_captcha_claude(question, images)

    if target_label and correct_ids:
        correct_imgs = [img for img in images if img['id'] in correct_ids and img.get('hashes')]
        if correct_imgs:
            save_captcha_db(correct_imgs, target_label)

    return correct_ids


def _detect_content_type(data: bytes) -> str:
    if data[:2] == b'\x89\x50':
        return 'image/png'
    if data[:2] == b'\x47\x49':
        return 'image/gif'
    if data[:4] == b'\x52\x49\x46\x46':
        return 'image/webp'
    return 'image/jpeg'


def _dump_page(page, tag: str):
    try:
        log(f'⚠️ 目前 URL: {page.url}')
        snap = BASE_DIR / f'debug_{tag}.html'
        snap.write_text(page.content(), encoding='utf-8')
        shot = BASE_DIR / f'debug_{tag}.png'
        page.screenshot(path=str(shot), full_page=True)
        log(f'⚠️ 已存除錯檔: {snap.name} / {shot.name}')
    except Exception as e:
        log(f'dump 失敗: {e}')


def handle_captcha(page):
    log('等待 CAPTCHA modal...')
    page.wait_for_selector('#modalYCaptchaV2', timeout=15000)
    time.sleep(0.5)

    for attempt in range(1, 6):
        log(f'CAPTCHA 第 {attempt} 次嘗試')

        title_el = page.locator('#modalYCaptchaV2 .modal-title')
        question = title_el.inner_text().strip() if title_el.count() > 0 else '請選擇正確的圖片'
        log(f'題目: {question}')

        img_data: list[dict] = []
        seen_ids: set = set()

        def collect_page():
            for row in page.locator('#tableCaptcha tr:not(.d-none)').all():
                for img in row.locator('img.y-captcha-image').all():
                    img_id = img.get_attribute('id')
                    img_src = img.get_attribute('src')
                    if img_id and img_src and img_id not in seen_ids:
                        seen_ids.add(img_id)
                        img_data.append({'id': img_id, 'url': img_src})

        collect_page()

        for _ in range(10):
            chevron = page.locator('#tableCaptcha tr:not(.d-none) a:not(.d-none) .fa-chevron-right').first
            if chevron.count() == 0:
                break
            try:
                chevron.evaluate('el => el.closest("a").click()')
                time.sleep(0.8)
                collect_page()
            except Exception:
                break

        log(f'共找到 {len(img_data)} 張圖片（含翻頁）')

        images: list[dict] = []
        for item in img_data:
            try:
                resp = page.request.get(item['url'])
                img_bytes = resp.body()
                images.append({
                    'id': item['id'],
                    'base64': base64.b64encode(img_bytes).decode(),
                    'content_type': _detect_content_type(img_bytes),
                })
            except Exception as e:
                log(f'下載圖片失敗 {item["id"]}: {e}')

        correct_ids = resolve_captcha(question, images)
        log(f'應點擊: {correct_ids}')

        for cid in correct_ids:
            try:
                page.evaluate('id => document.getElementById(id)?.click()', cid)
                log(f'點擊圖片 {cid}')
                time.sleep(0.3)
            except Exception as e:
                log(f'點擊失敗 {cid}: {e}')

        time.sleep(0.5)

        if page.locator('#btnConfirm').count() > 0:
            page.evaluate('() => document.getElementById("btnConfirm")?.click()')
            log('點擊驗證按鈕')

        time.sleep(2)

        error_el = page.locator('#modalYCaptchaV2 .message.text-danger')
        if error_el.count() > 0 and error_el.inner_text().strip():
            log(f'第 {attempt} 次失敗，重試...')
            time.sleep(1)
            continue

        modal = page.locator('#modalYCaptchaV2')
        try:
            modal.wait_for(state='hidden', timeout=3000)
            log('✅ CAPTCHA 驗證成功！')
            return
        except Exception:
            pass

        classes = modal.get_attribute('class') or ''
        if 'show' not in classes:
            log('✅ CAPTCHA 驗證成功！')
            return

        log(f'第 {attempt} 次結果不明，繼續...')
        time.sleep(1)

    raise RuntimeError('CAPTCHA 重試 5 次仍失敗')


def login(page):
    """登入流程，回傳 None；登入後 page 已停在已驗證的 session"""
    log('前往投資明細頁（觸發登入導向）...')
    page.goto(TRANS_URL, wait_until='domcontentloaded', timeout=30000)
    time.sleep(2)

    current_url = page.url.lower()
    if 'login/otplogin' not in current_url:
        log(f'✅ Session 有效，已在頁面: {page.url}，跳過登入流程')
        return

    log('被導向登入頁，開始登入流程...')
    page.wait_for_selector('#loginid', timeout=15000)

    fill_input(page, '#loginid', WEB_ID)
    log(f'填入帳號: {WEB_ID}')
    fill_input(page, '#loginPWD', PASSWORD)
    log('填入密碼')
    time.sleep(0.5)

    label = page.locator('label[for="chbYCaptchaV2"]')
    if label.count() > 0:
        label.click()
        log('點擊「我是元大客戶」')
    time.sleep(2)

    handle_captcha(page)

    time.sleep(1)
    for i in range(10):
        chb = page.locator('#chbYCaptchaV2')
        if chb.count() > 0 and chb.evaluate('el => el.checked'):
            log('chbYCaptchaV2 已勾選')
            break
        log(f'等待 checkbox... ({i + 1})')
        time.sleep(0.5)

    time.sleep(3)

    if page.locator('#loginBtn').count() > 0:
        page.evaluate('() => document.getElementById("loginBtn")?.click()')
        log('點擊登入按鈕')

    log('等待登入後跳轉...')
    try:
        wait_url_leaves(page, 'login/otplogin', timeout=90)
    except TimeoutError:
        _dump_page(page, 'login_stuck')
        raise
    log(f'登入完成，到達: {page.url}')

    if 'checkcert' in page.url.lower():
        log('安控檢查頁面，等待 ServiSign 自動驗證...')
        for btn_text in ['確認', '繼續', '確定', 'OK', '登入']:
            if click_button_by_text(page, btn_text, visible_only=False):
                time.sleep(2)
                break
        try:
            wait_url_leaves(page, 'checkcert', timeout=90)
            log(f'ServiSign 驗證通過，到達: {page.url}')
        except Exception:
            _dump_page(page, 'checkcert_stuck')
            raise RuntimeError('ServiSign 安控驗證未通過')

    time.sleep(2)
    click_button_by_text(page, '離開', label='關閉殘留彈窗', visible_only=True)


def fetch_ex_dividends(page) -> list:
    """透過點選選單導覽到除權除息表，攔截頁面自己觸發的 GetExDividends XHR"""
    captured = {}
    seen_urls = []

    def handle_response(response):
        url = response.url
        if 'ExDividend' in url:
            seen_urls.append(url)
            log(f'  [response] {response.status} {url}')
        if 'GetExDividends' in url and 'Options' not in url:
            try:
                body = response.text()
                captured['url'] = url
                captured['status'] = response.status
                captured['body'] = body
                log(f'  ✅ 抓到目標 XHR: {url} ({len(body)} bytes)')
            except Exception as e:
                log(f'  ⚠️ 讀取回應 body 失敗: {e}')

    page.on('response', handle_response)

    log('點選「公告訊息」...')
    if not click_button_by_text(page, '公告訊息', visible_only=True):
        page.get_by_text('公告訊息', exact=True).first.click()

    # 等待頁面穩定（networkidle 比固定 sleep 更可靠）
    try:
        page.wait_for_load_state('networkidle', timeout=15000)
    except Exception:
        pass
    time.sleep(2)

    if not captured:
        log('第一次點擊後尚未抓到，嘗試點選「除權除息表」分頁...')
        try:
            page.get_by_text('除權除息表', exact=True).first.click()
            page.wait_for_load_state('networkidle', timeout=15000)
        except Exception as e:
            log(f'點選除權除息表失敗: {e}')
        time.sleep(2)

    if not captured:
        # 頁面可能從 localStorage/Pinia 還原快取資料而沒有真的打 API，
        # 強迫重新選擇下拉選單觸發新的 XHR
        log('疑似從本地快取還原，嘗試重新觸發下拉選單...')
        try:
            select2 = page.locator('label.yt-select:has-text("近期除權息個股")').first
            if select2.count() == 0:
                select2 = page.locator('.yt-select').nth(1)
            select2.click()
            time.sleep(1)
            # 先選「全部」(若有此選項) 強制變更篩選條件
            all_opt = page.get_by_role('option', name='全部').first
            if all_opt.count() > 0:
                all_opt.click()
                time.sleep(2)
            # 再切回「近期除權息個股」
            select2.click()
            time.sleep(1)
            recent_opt = page.get_by_role('option', name='近期除權息個股').first
            if recent_opt.count() > 0:
                recent_opt.click()
            page.wait_for_load_state('networkidle', timeout=15000)
        except Exception as e:
            log(f'重新觸發下拉選單失敗: {e}')
        time.sleep(2)

    # 最後再等幾秒讓非同步回應到齊
    for _ in range(8):
        if captured:
            break
        time.sleep(1)

    page.remove_listener('response', handle_response)

    if not captured:
        log(f'曾看到的 ExDividend 相關 URL: {seen_urls}')
        _dump_page(page, 'exdividend_no_xhr')
        raise RuntimeError('未攔截到 GetExDividends XHR，請檢查 debug_exdividend_no_xhr.html/png')

    log(f'攔截到: {captured["url"]} status={captured["status"]}')
    raw_text = captured['body']

    out_path = BASE_DIR / 'debug_exdividends_raw.json'
    out_path.write_text(raw_text, encoding='utf-8')
    log(f'已存原始回應: {out_path.name} ({len(raw_text)} bytes)')

    return json.loads(raw_text)


def main():
    from playwright.sync_api import sync_playwright

    chrome_path = next((p for p in CHROME_PATHS if p.exists()), None)

    with sync_playwright() as p:
        launch_kwargs: dict = {
            'user_data_dir': str(USER_DATA_DIR),
            'headless': HEADLESS,
            'accept_downloads': True,
            'args': [
                f'--profile-directory={PROFILE_DIR}',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessChecks',
            ],
            'ignore_default_args': ['--enable-automation'],
        }
        if chrome_path:
            log(f'使用系統 Chrome: {chrome_path}')
            launch_kwargs['executable_path'] = str(chrome_path)
        else:
            log('系統 Chrome 未找到，改用 channel=chrome 自動偵測')
            launch_kwargs['channel'] = 'chrome'

        log(f'profile: {USER_DATA_DIR}\\{PROFILE_DIR}  headless={HEADLESS}')
        try:
            context = p.chromium.launch_persistent_context(**launch_kwargs)
        except Exception as e:
            log(f'❌ 啟動失敗（profile 可能被佔用）: {e}')
            log('請先完全關閉所有 Chrome 視窗再執行')
            raise

        page = context.pages[0] if context.pages else context.new_page()

        def on_dialog(dialog):
            if '請輸入密碼' in dialog.message:
                log(f'攔截 alert: {dialog.message}')
                dialog.dismiss()
            else:
                dialog.accept()

        page.on('dialog', on_dialog)

        try:
            login(page)

            raw = fetch_ex_dividends(page)

            # 印出結構摘要，方便確認欄位名稱
            if isinstance(raw, list):
                log(f'回傳為 list，共 {len(raw)} 筆')
                if raw:
                    log('第一筆內容:')
                    print(json.dumps(raw[0], ensure_ascii=False, indent=2))
            elif isinstance(raw, dict):
                log(f'回傳為 dict，keys: {list(raw.keys())}')
                # 嘗試找資料陣列欄位
                for k, v in raw.items():
                    if isinstance(v, list):
                        log(f'  欄位 "{k}" 是 list，共 {len(v)} 筆')
                        if v:
                            print(json.dumps(v[0], ensure_ascii=False, indent=2))
            else:
                log(f'未預期的回傳型別: {type(raw)}')

        finally:
            context.close()

    log('完成！請檢查 debug_exdividends_raw.json 確認完整欄位結構')


if __name__ == '__main__':
    main()
