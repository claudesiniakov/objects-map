"""Ежедневная резервная копия базы: sqlite backup API + gzip, хранение 14 дней."""
import gzip
import os
import shutil
import sqlite3
import time
from datetime import datetime
from pathlib import Path

DATA = Path(os.environ.get("OBJMAP_DATA_DIR", "/var/lib/objects-map"))
KEEP_DAYS = 14

backups = DATA / "backups"
backups.mkdir(exist_ok=True)
tmp = backups / "tmp.sqlite3"
src = sqlite3.connect(DATA / "objmap.sqlite3")
dst = sqlite3.connect(tmp)
src.backup(dst)
dst.close()
src.close()
out = backups / f"objmap-{datetime.now():%Y-%m-%d_%H%M}.sqlite3.gz"
with tmp.open("rb") as f, gzip.open(out, "wb") as g:
    shutil.copyfileobj(f, g)
tmp.unlink()
cutoff = time.time() - KEEP_DAYS * 86400
for p in backups.glob("objmap-*.sqlite3.gz"):
    if p.stat().st_mtime < cutoff:
        p.unlink()
print(out)
