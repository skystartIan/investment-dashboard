"""
yuanta_config_server.py  v3.0
本地設定伺服器 + CAPTCHA 圖片資料庫（三重感知雜湊）

API 端點：
  GET  /config           → 回傳帳密和 API Key
  POST /captcha/lookup   → 查詢圖片（三重 hash 比對）
  POST /captcha/save     → 儲存圖片和類別
  GET  /captcha/stats    → 資料庫統計

啟動方式：
    python yuanta_config_server.py
"""

import os
import json
import base64
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from io import BytesIO

try:
    import imagehash
    from PIL import Image
    PHASH_AVAILABLE = True
except ImportError:
    PHASH_AVAILABLE = False
    print('⚠️  imagehash/Pillow 未安裝，請執行: pip install imagehash Pillow')

BASE_DIR = Path(__file__).parent
DB_DIR   = BASE_DIR / 'captcha_db'
IMG_DIR  = DB_DIR / 'images'
DB_FILE  = DB_DIR / 'db.json'

DB_DIR.mkdir(exist_ok=True)
IMG_DIR.mkdir(exist_ok=True)

# 三重 hash 閾值
PHASH_THRESH = 15
AHASH_THRESH = 8
DHASH_THRESH = 10

def load_env():
    env_path = BASE_DIR / '.env'
    if env_path.exists():
        for line in env_path.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ[k.strip()] = v.strip()

load_env()

def load_db() -> list:
    """db.json 格式: [{"ph": "...", "ah": "...", "dh": "...", "label": "...", "file": "..."}]"""
    if DB_FILE.exists():
        data = json.loads(DB_FILE.read_text(encoding='utf-8'))
        # 舊格式（dict）自動忽略，回傳空
        if isinstance(data, list):
            return data
    return []

def save_db(db: list):
    DB_FILE.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding='utf-8')

def compute_hashes(img_bytes: bytes) -> dict:
    """計算三種感知雜湊"""
    img = Image.open(BytesIO(img_bytes)).convert('RGB')
    return {
        'ph': str(imagehash.phash(img)),
        'ah': str(imagehash.average_hash(img)),
        'dh': str(imagehash.dhash(img)),
    }

def hash_distance(h1: str, h2: str) -> int:
    return imagehash.hex_to_hash(h1) - imagehash.hex_to_hash(h2)

def find_match(db: list, hashes: dict) -> str | None:
    """三重 hash 都在閾值內才算命中，回傳類別"""
    for entry in db:
        if (hash_distance(hashes['ph'], entry['ph']) < PHASH_THRESH and
            hash_distance(hashes['ah'], entry['ah']) <= AHASH_THRESH and
            hash_distance(hashes['dh'], entry['dh']) <= DHASH_THRESH):
            return entry['label']
    return None

def is_duplicate(db: list, hashes: dict) -> bool:
    """檢查是否已有相同圖片"""
    return find_match(db, hashes) is not None


class ConfigHandler(BaseHTTPRequestHandler):

    def _send_json(self, data: dict, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get('Content-Length', 0))
        return json.loads(self.rfile.read(length))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/config':
            self._send_json({
                'WEB_ID':           os.environ.get('YUANTA_WEB_ID', ''),
                'PASSWORD':         os.environ.get('YUANTA_PASSWORD', ''),
                'ANTHROPIC_KEY':    os.environ.get('ANTHROPIC_API_KEY', ''),
                'WORKDO_EMAIL':        os.environ.get('WORKDO_EMAIL', ''),
                'WORKDO_PASSWORD':     os.environ.get('WORKDO_PASSWORD', ''),
                'TELEGRAM_BOT_TOKEN':  os.environ.get('TELEGRAM_BOT_TOKEN', ''),
                'TELEGRAM_CHAT_ID':    os.environ.get('TELEGRAM_CHAT_ID', ''),
            })

        elif self.path == '/captcha/stats':
            db = load_db()
            stats = {}
            for entry in db:
                label = entry.get('label', '')
                stats[label] = stats.get(label, 0) + 1
            self._send_json({'total': len(db), 'by_label': stats})

        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/captcha/lookup':
            # body: {"images": [{"id": "xxx", "b64": "..."}]}
            try:
                if not PHASH_AVAILABLE:
                    self._send_json({'error': 'imagehash 未安裝'}, 500)
                    return
                body = self._read_body()
                db   = load_db()
                results = {}
                for img in body.get('images', []):
                    img_bytes = base64.b64decode(img['b64'])
                    hashes    = compute_hashes(img_bytes)
                    label     = find_match(db, hashes)
                    results[img['id']] = {
                        'hashes': hashes,
                        'label':  label,  # None = 不在資料庫
                    }
                self._send_json({'results': results})
            except Exception as e:
                self._send_json({'error': str(e)}, 500)

        elif self.path == '/captcha/save':
            # body: {"images": [{"b64": "...", "hashes": {...}, "label": "貓"}]}
            try:
                if not PHASH_AVAILABLE:
                    self._send_json({'error': 'imagehash 未安裝'}, 500)
                    return
                body  = self._read_body()
                db    = load_db()
                saved = 0
                for img in body.get('images', []):
                    label  = img.get('label', '')
                    b64    = img.get('b64', '')
                    hashes = img.get('hashes', {})
                    if not label or not hashes:
                        continue
                    # 若已有相同圖片則跳過
                    if is_duplicate(db, hashes):
                        print(f'  [CAPTCHA DB] 重複圖片跳過 [{label}]')
                        continue
                    # 存圖片
                    fname = hashes.get('ph', 'unknown') + '.png'
                    img_path = IMG_DIR / fname
                    if not img_path.exists() and b64:
                        img_path.write_bytes(base64.b64decode(b64))
                    # 存資料庫
                    db.append({
                        'ph':    hashes['ph'],
                        'ah':    hashes['ah'],
                        'dh':    hashes['dh'],
                        'label': label,
                        'file':  fname,
                    })
                    saved += 1
                save_db(db)
                print(f'  [CAPTCHA DB] +{saved} 筆，共 {len(db)} 筆')
                self._send_json({'saved': saved, 'total': len(db)})
            except Exception as e:
                self._send_json({'error': str(e)}, 500)

        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


if __name__ == '__main__':
    import sys, subprocess

    # 若非前景模式，自動用 ARM64 pythonw.exe 背景重啟（無視窗）
    if '--fg' not in sys.argv:
        pythonw = Path(r'C:\Users\Administrator\AppData\Local\Programs\Python\Python311-arm64\pythonw.exe')
        if pythonw.exists():
            subprocess.Popen(
                [str(pythonw), str(Path(__file__).resolve()), '--fg'],
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
            print('✅ config server 已在背景啟動（無視窗），可關閉此視窗')
            sys.exit(0)

    if not PHASH_AVAILABLE:
        print('請先執行: pip install imagehash Pillow --break-system-packages')
        exit(1)
    db = load_db()
    server = HTTPServer(('127.0.0.1', 8765), ConfigHandler)

    # 在背景執行 HTTP server
    import threading
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()

    # 嘗試顯示系統匣圖示
    try:
        import pystray
        from PIL import Image, ImageDraw

        def make_icon():
            img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            d.ellipse([4, 4, 60, 60], fill='#0067B3')
            d.rectangle([28, 20, 36, 44], fill='white')
            d.ellipse([27, 46, 37, 56], fill='white')
            return img

        db_count = len(load_db())
        menu = pystray.Menu(
            pystray.MenuItem(f'元大 Config Server  ●  port 8765', None, enabled=False),
            pystray.MenuItem(f'CAPTCHA 資料庫：{db_count} 筆', None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem('停止', lambda icon, _: (icon.stop(), server.shutdown())),
        )
        icon = pystray.Icon('YuantaConfigServer', make_icon(), '元大 Config Server', menu)
        icon.run()          # 主執行緒在這裡等，關圖示才退出
    except ImportError:
        # pystray 未安裝，直接等待
        print('✅ 設定伺服器啟動：http://localhost:8765')
        print(f'   CAPTCHA 資料庫：{len(db)} 筆')
        t.join()
