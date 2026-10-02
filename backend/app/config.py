import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("OBJMAP_DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "objmap.sqlite3"
IMPORT_DIR = DATA_DIR / "imports"
ICON_DIR = DATA_DIR / "icons"
BACKUP_DIR = DATA_DIR / "backups"

for d in (DATA_DIR, IMPORT_DIR, ICON_DIR, BACKUP_DIR):
    d.mkdir(parents=True, exist_ok=True)


def _load_secret() -> str:
    env = os.environ.get("OBJMAP_SECRET")
    if env:
        return env
    path = DATA_DIR / "secret.key"
    if not path.exists():
        path.write_text(secrets.token_urlsafe(48))
        path.chmod(0o600)
    return path.read_text().strip()


SECRET = _load_secret()
TOKEN_HOURS = 12
MAX_UPLOAD_MB = 20
MAX_ROWS = 100_000
MAX_RADIUS_M = 100_000
BACKUP_KEEP_DAYS = 14
