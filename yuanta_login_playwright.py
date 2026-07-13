"""
yuanta_login_playwright.py  v1.0
使用 Playwright 以無頭 ARM64 Chrome 自動登入元大網站
完全取代 Tampermonkey + 手動開瀏覽器流程

流程：
  登入 → CAPTCHA → 投資明細下載 → 未實現損益下載

使用方式：
    python yuanta_login_playwright.py

依賴：
    pip install playwright anthropic requests
    playwright install chrome   ← 或指定 ARM64 系統 Chrome（見下方 CHROME_PATH）
"""

import base64
import json
import os
import re
import sys
import time
from pathlib import Path

# 強制 UTF-8 輸出（Windows console 預設 cp1252 無法輸出中文）
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

import requests as req_lib

BASE_DIR      = Path(__file__).parent
DOWNLOAD_DIR  = BASE_DIR / 'downloads'
DOWNLOAD_DIR.mkdir(exist_ok=True)

# ARM64 系統 Chrome 路徑（找不到時改用 channel="chrome" 自動偵測）
CHROME_PATHS = [
    Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe'),
    Path(r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'),
]

# 專用自動化 profile（不能用 Chrome 預設 "User Data" 目錄，Chrome 136+ 禁止對其開
# remote debugging）。ServiSign 安控元件是獨立本機服務（127.0.0.1:56435），憑證在
# OS 憑證庫，與 Chrome profile 無關，故新建 profile 即可。
# 環境變數覆寫：YUANTA_HEADLESS=1 開 headless / =0 顯示視窗
USER_DATA_DIR  = Path(os.environ.get(
    'YUANTA_CHROME_PROFILE',
    str(BASE_DIR / 'chrome_profile')))
PROFILE_DIR    = os.environ.get('YUANTA_CHROME_PROFILE_DIR', 'Default')
HEADLESS       = os.environ.get('YUANTA_HEADLESS', '0') == '1'

LOGIN_URL    = 'https://global.yuanta.com.tw/NexusWebTrade/Login/OtpLogin'
TRANS_URL    = 'https://global.yuanta.com.tw/NexusWebTrade/nexuswebtrade/trans'
UNREALPF_URL = 'https://global.yuanta.com.tw/NexusWebTrade/nexuswebtrade/UnRealPF'

CONFIG_SERVER = 'http://localhost:8765'

# ──────────────────────────────────────────────────────────
# 設定載入
# ──────────────────────────────────────────────────────────

def load_env():
    env_path = BASE_DIR / '.env'
    if env_path.exists():
        for line in env_path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ[k.strip()] = v.strip()

load_env()
WEB_ID        = os.environ.get('YUANTA_WEB_ID', '')
PASSWORD      = os.environ.get('YUANTA_PASSWORD', '')
ANTHROPIC_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

if not WEB_ID or not PASSWORD:
    print('❌ .env 缺少 YUANTA_WEB_ID 或 YUANTA_PASSWORD，請補齊後再執行')
    sys.exit(1)

# ──────────────────────────────────────────────────────────
# 工具
# ──────────────────────────────────────────────────────────

def log(msg: str):
    print(f'[元大自動化] {msg}')


def wait_url_leaves(page, substr: str, timeout: int = 30) -> str:
    """等待 URL 不再包含 substr（事件驅動，正確處理導航）"""
    substr = substr.lower()
    page.wait_for_url(lambda url: substr not in url.lower(), timeout=timeout * 1000)
    return page.url


def click_button_by_text(page, text: str, label: str = None, visible_only: bool = False) -> bool:
    """找到文字相符的 button 並點擊，回傳是否點到"""
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
    """使用 native setter 觸發 React/Vue 合成事件"""
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
# CAPTCHA：Claude API
# ──────────────────────────────────────────────────────────

def solve_captcha_claude(question: str, images: list) -> list:
    """images: [{'id', 'base64', 'content_type'}] → 回傳正確 id 列表"""
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

# ──────────────────────────────────────────────────────────
# CAPTCHA：本地資料庫（透過 config server）
# ──────────────────────────────────────────────────────────

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
            img['label']  = db_results[img['id']].get('label')

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

# ──────────────────────────────────────────────────────────
# CAPTCHA 主處理
# ──────────────────────────────────────────────────────────

def _detect_content_type(data: bytes) -> str:
    if data[:2] == b'\x89\x50':
        return 'image/png'
    if data[:2] == b'\x47\x49':
        return 'image/gif'
    if data[:4] == b'\x52\x49\x46\x46':
        return 'image/webp'
    return 'image/jpeg'


def handle_captcha(page):
    log('等待 CAPTCHA modal...')
    page.wait_for_selector('#modalYCaptchaV2', timeout=15000)
    time.sleep(0.5)

    for attempt in range(1, 6):
        log(f'CAPTCHA 第 {attempt} 次嘗試')

        title_el = page.locator('#modalYCaptchaV2 .modal-title')
        question = title_el.inner_text().strip() if title_el.count() > 0 else '請選擇正確的圖片'
        log(f'題目: {question}')

        # 收集所有圖片（含翻頁）
        img_data: list[dict] = []
        seen_ids: set = set()

        def collect_page():
            for row in page.locator('#tableCaptcha tr:not(.d-none)').all():
                for img in row.locator('img.y-captcha-image').all():
                    img_id  = img.get_attribute('id')
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

        # 下載圖片 → base64
        images: list[dict] = []
        for item in img_data:
            try:
                resp      = page.request.get(item['url'])
                img_bytes = resp.body()
                images.append({
                    'id':           item['id'],
                    'base64':       base64.b64encode(img_bytes).decode(),
                    'content_type': _detect_content_type(img_bytes),
                })
            except Exception as e:
                log(f'下載圖片失敗 {item["id"]}: {e}')

        correct_ids = resolve_captcha(question, images)
        log(f'應點擊: {correct_ids}')

        # 用原生 JS click 觸發 onclick（圖片可能在隱藏分頁，繞過可見性檢查）
        for cid in correct_ids:
            try:
                page.evaluate('id => document.getElementById(id)?.click()', cid)
                log(f'點擊圖片 {cid}')
                time.sleep(0.3)
            except Exception as e:
                log(f'點擊失敗 {cid}: {e}')

        time.sleep(0.5)

        # 驗證按鈕帶 d-none，同樣用 JS click
        if page.locator('#btnConfirm').count() > 0:
            page.evaluate('() => document.getElementById("btnConfirm")?.click()')
            log('點擊驗證按鈕')

        time.sleep(2)

        # 錯誤訊息 → 重試
        error_el = page.locator('#modalYCaptchaV2 .message.text-danger')
        if error_el.count() > 0 and error_el.inner_text().strip():
            log(f'第 {attempt} 次失敗，重試...')
            time.sleep(1)
            continue

        # 檢查 modal 是否關閉
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

# ──────────────────────────────────────────────────────────
# 下載輔助
# ──────────────────────────────────────────────────────────

def _dump_page(page, tag: str):
    """找不到元素時 dump 頁面狀態方便除錯"""
    try:
        log(f'⚠️ 目前 URL: {page.url}')
        snap = BASE_DIR / f'debug_{tag}.html'
        snap.write_text(page.content(), encoding='utf-8')
        shot = BASE_DIR / f'debug_{tag}.png'
        page.screenshot(path=str(shot), full_page=True)
        log(f'⚠️ 已存除錯檔: {snap.name} / {shot.name}')
    except Exception as e:
        log(f'dump 失敗: {e}')


def wait_download_button(page, tag: str, timeout: int = 30000):
    try:
        page.wait_for_selector('#btnDownloadExcel', timeout=timeout)
        time.sleep(1)
    except Exception:
        _dump_page(page, tag)
        raise


def download_excel(page, default_name: str, label: str):
    with page.expect_download(timeout=30000) as dl_info:
        page.evaluate('() => document.getElementById("btnDownloadExcel")?.click()')
        log(f'點擊下載{label}')
    dl    = dl_info.value
    fname = dl.suggested_filename or default_name
    dl.save_as(str(DOWNLOAD_DIR / fname))
    log(f'✅ {label}下載完成: {fname}')


# ──────────────────────────────────────────────────────────
# 除權除息表（股利自動化）
# ──────────────────────────────────────────────────────────

def fetch_ex_dividends(page) -> dict | None:
    """點選「公告訊息 → 除權除息表」攔截 GetExDividends XHR，回傳 raw dict 或 None（失敗時不丟例外）"""
    captured = {}
    seen_urls = []

    def handle_response(response):
        url = response.url
        if 'ExDividend' in url:
            seen_urls.append(url)
        if 'GetExDividends' in url and 'Options' not in url:
            try:
                captured['body'] = response.text()
            except Exception as e:
                log(f'  ⚠️ 讀取除權除息表回應失敗: {e}')

    page.on('response', handle_response)
    try:
        log('點選「公告訊息」...')
        if not click_button_by_text(page, '公告訊息', visible_only=True):
            page.get_by_text('公告訊息', exact=True).first.click()
        try:
            page.wait_for_load_state('networkidle', timeout=15000)
        except Exception:
            pass
        time.sleep(2)

        if not captured:
            try:
                page.get_by_text('除權除息表', exact=True).first.click()
                page.wait_for_load_state('networkidle', timeout=15000)
            except Exception:
                pass
            time.sleep(2)

        if not captured:
            # 頁面可能從本地快取還原而未真正打 API，強迫重新觸發下拉選單
            # 此元件實際位於內嵌 iframe（ytdf.yuanta.com.tw），故用 page.frame_locator 短逾時嘗試，
            # 找不到就快速放棄（fallback 而已，不影響已抓到資料的情況）
            try:
                frame = page.frame_locator('iframe').first
                select2 = frame.locator('.yt-select').nth(1)
                select2.click(timeout=5000)
                time.sleep(1)
                all_opt = frame.get_by_role('option', name='全部').first
                if all_opt.count() > 0:
                    all_opt.click(timeout=5000)
                    time.sleep(2)
                select2.click(timeout=5000)
                time.sleep(1)
                recent_opt = frame.get_by_role('option', name='近期除權息個股').first
                if recent_opt.count() > 0:
                    recent_opt.click(timeout=5000)
                page.wait_for_load_state('networkidle', timeout=15000)
            except Exception as e:
                log(f'  重新觸發下拉選單失敗（非致命，繼續）: {e}')
            time.sleep(2)

        for _ in range(8):
            if captured:
                break
            time.sleep(1)
    finally:
        page.remove_listener('response', handle_response)

    if not captured:
        log(f'⚠️ 未攔截到除權除息表 XHR（曾看到: {seen_urls}），略過股利同步')
        return None

    import json
    return json.loads(captured['body'])


# ──────────────────────────────────────────────────────────
# 主流程
# ──────────────────────────────────────────────────────────

def main():
    from playwright.sync_api import sync_playwright

    # 找 ARM64 Chrome
    chrome_path = next((p for p in CHROME_PATHS if p.exists()), None)

    with sync_playwright() as p:
        # 用真實 profile 的持久化 context（ServiSign 安控元件需要此環境）
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
        browser = context
        page    = context.pages[0] if context.pages else context.new_page()

        # 攔截「請輸入密碼」alert
        def on_dialog(dialog):
            if '請輸入密碼' in dialog.message:
                log(f'攔截 alert: {dialog.message}')
                dialog.dismiss()
            else:
                dialog.accept()

        page.on('dialog', on_dialog)

        try:
            # ── 步驟 1：登入（若 session 仍有效則跳過）──────
            # 先開目標頁，讓系統把我們導向登入頁並帶上正確的 returnurl
            # （直接開登入頁會導致 returnurl 為空，登入後點「離開」會被踢回登入頁）
            log('前往投資明細頁（觸發登入導向）...')
            page.goto(TRANS_URL, wait_until='domcontentloaded', timeout=30000)
            time.sleep(2)

            current_url = page.url.lower()
            if 'login/otplogin' in current_url:
                # ── 需要登入 ──
                log('被導向登入頁，開始登入流程...')
                page.wait_for_selector('#loginid', timeout=15000)

                fill_input(page, '#loginid',  WEB_ID)
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

                # 等 checkbox 被勾選
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

                # ── 步驟 2：處理登入後頁面 ────────────────────
                log('等待登入後跳轉...')
                try:
                    wait_url_leaves(page, 'login/otplogin', timeout=90)
                except TimeoutError:
                    try:
                        body_txt = page.locator('body').inner_text()
                        for kw in ['密碼', '錯誤', '失敗', '驗證', '帳號', '鎖定', '逾時']:
                            if kw in body_txt:
                                log(f'登入頁仍有訊息含「{kw}」')
                    except Exception:
                        pass
                    _dump_page(page, 'login_stuck')
                    raise
                log(f'登入完成，到達: {page.url}')

                # 安控憑證檢查頁
                if 'checkcert' in page.url.lower():
                    log('安控檢查頁面，等待 ServiSign 自動驗證...')
                    _dump_page(page, 'checkcert_before')
                    for btn_text in ['確認', '繼續', '確定', 'OK', '登入']:
                        if click_button_by_text(page, btn_text, visible_only=False):
                            time.sleep(2)
                            break
                    try:
                        wait_url_leaves(page, 'checkcert', timeout=90)
                        log(f'ServiSign 驗證通過，到達: {page.url}')
                    except Exception:
                        log('⚠️ ServiSign 未自動通過，dump 頁面分析')
                        _dump_page(page, 'checkcert_stuck')
                        raise RuntimeError('ServiSign 安控驗證未通過')

                # 可能落在 /announce，統一導到投資明細
                time.sleep(2)
                click_button_by_text(page, '離開', label='關閉殘留彈窗', visible_only=True)

            else:
                # ── Session 仍有效，無需登入 ──
                log(f'✅ Session 有效，已在頁面: {page.url}，跳過登入流程')

            # ── 步驟 3：投資明細下載 ──────────────────────
            if 'nexuswebtrade/trans' not in page.url.lower():
                log('前往投資明細頁...')
                page.goto(TRANS_URL, wait_until='networkidle', timeout=40000)
            log(f'投資明細頁到達: {page.url}')
            wait_download_button(page, 'trans')

            select = page.locator('#selectDateRange')
            if select.count() > 0:
                select.select_option('3')
                log('選擇「本月」')
                time.sleep(1.5)

            download_excel(page, 'yuanta_trans.xls', '投資明細')
            time.sleep(2)

            # ── 步驟 4：未實現損益下載 ────────────────────
            log('前往未實現損益頁...')
            page.goto(UNREALPF_URL, wait_until='networkidle', timeout=40000)
            wait_download_button(page, 'unrealpf')

            download_excel(page, 'yuanta_unrealpf.xls', '未實現損益')

            # ── 步驟 5：除權除息表 → 同步股利（失敗不影響上述既有流程）──
            try:
                log('抓取除權除息表...')
                ex_div_raw = fetch_ex_dividends(page)
                if ex_div_raw is not None:
                    from yuanta_dividend_sync import get_sheets_client, sync_dividends, SPREADSHEET_NAME
                    gc = get_sheets_client()
                    wb = gc.open(SPREADSHEET_NAME)
                    sync_dividends(wb, ex_div_raw)
            except Exception as e:
                log(f'⚠️ 股利同步失敗（不影響投資明細/未實現損益）：{e}')

        finally:
            browser.close()

    log('全部完成！')


if __name__ == '__main__':
    main()
