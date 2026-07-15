import glob
import os
import logging
from pathlib import Path

DOWNLOADS_DIR = Path(__file__).parent / "downloads"

YUANTA_PATTERNS = [
    "投資明細*.xls",
    "投資明細*.xlsx",
    "未實現損益*.xls",
    "未實現損益*.xlsx",
]

logging.basicConfig(
    filename=Path(__file__).parent / "cleanup_downloads.log",
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

def cleanup():
    deleted = []
    for pattern in YUANTA_PATTERNS:
        for f in DOWNLOADS_DIR.glob(pattern):
            try:
                f.unlink()
                deleted.append(f.name)
                logging.info(f"已刪除: {f.name}")
            except Exception as e:
                logging.error(f"刪除失敗 {f.name}: {e}")

    if deleted:
        logging.info(f"共刪除 {len(deleted)} 個檔案")
    else:
        logging.info("無符合檔案，略過")

if __name__ == "__main__":
    cleanup()
