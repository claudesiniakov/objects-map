import json
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from .config import DATA_DIR, DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS object_type (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'circle',
    color TEXT NOT NULL DEFAULT '#1e88e5',
    has_radius INTEGER NOT NULL DEFAULT 0,
    default_radius_m INTEGER,
    fill_opacity REAL NOT NULL DEFAULT 0.2,
    sort_order INTEGER NOT NULL DEFAULT 0,
    visible_default INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
    full_name TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batch (
    id INTEGER PRIMARY KEY,
    file_name TEXT NOT NULL,
    stored_file TEXT NOT NULL,
    source TEXT,
    user_id INTEGER REFERENCES user(id),
    user_login TEXT,
    created_at TEXT NOT NULL,
    mode TEXT,
    status TEXT NOT NULL DEFAULT 'uploaded',
    sheet TEXT,
    mapping TEXT,
    added INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    committed_at TEXT,
    rolled_back_at TEXT
);

CREATE TABLE IF NOT EXISTS map_object (
    id INTEGER PRIMARY KEY,
    external_id TEXT UNIQUE,
    contract_number TEXT,
    cadastral_number TEXT,
    type_id INTEGER NOT NULL REFERENCES object_type(id),
    name TEXT NOT NULL,
    address TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    radius_m INTEGER,
    description TEXT,
    attributes TEXT NOT NULL DEFAULT '{}',
    source TEXT,
    import_id INTEGER REFERENCES import_batch(id) ON DELETE SET NULL,
    search_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obj_latlon ON map_object(lat, lon);
CREATE INDEX IF NOT EXISTS idx_obj_type ON map_object(type_id);
CREATE INDEX IF NOT EXISTS idx_obj_source ON map_object(source);
CREATE INDEX IF NOT EXISTS idx_obj_import ON map_object(import_id);

CREATE TABLE IF NOT EXISTS import_change (
    id INTEGER PRIMARY KEY,
    import_id INTEGER NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
    object_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
    before TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_import ON import_change(import_id);

-- Комментарии к объекту. Связь по object_id без каскада: при импорте в режиме «Заменить» объекты
-- пересоздаются, и комментарии переносятся на новый объект с тем же внешним ID (importer.commit/rollback).
CREATE TABLE IF NOT EXISTS object_comment (
    id INTEGER PRIMARY KEY,
    object_id INTEGER NOT NULL,
    user_id INTEGER,
    user_login TEXT,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comment_object ON object_comment(object_id, id);

-- Личные метки пользователя (из поиска адресов): видит и меняет только владелец.
CREATE TABLE IF NOT EXISTS user_pin (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    address TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    color TEXT NOT NULL,
    radius_m INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pin_user ON user_pin(user_id);

CREATE TABLE IF NOT EXISTS mapping_template (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    mapping TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    user_id INTEGER,
    user_login TEXT,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    details TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {
    "center_lat": 55.751244,
    "center_lon": 37.618423,
    "zoom": 10,
    "cluster_radius": 60,
    "cluster_max_zoom": 16,
    "filter_attributes": ["Ответственный"],
}

OBJECT_COLUMNS = (
    "id", "external_id", "contract_number", "cadastral_number", "type_id", "name", "address", "lat", "lon", "radius_m",
    "description", "attributes", "source", "import_id", "search_text", "created_at", "updated_at",
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA synchronous = NORMAL")
    return con


def get_db():
    con = connect()
    try:
        yield con
    finally:
        con.close()


@contextmanager
def tx(con: sqlite3.Connection):
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
    except BaseException:
        con.execute("ROLLBACK")
        raise
    con.execute("COMMIT")


class DataVersion:
    """Счётчик версии данных карты — сбрасывает кэш выдачи /api/objects."""

    value = 0

    @classmethod
    def bump(cls):
        cls.value += 1


def search_text(*parts) -> str:
    return " ".join(str(p) for p in parts if p).lower()


def get_settings(con) -> dict:
    out = dict(DEFAULT_SETTINGS)
    for row in con.execute("SELECT key, value FROM settings"):
        out[row["key"]] = json.loads(row["value"])
    return out


def audit(con, user, action: str, entity: str, entity_id=None, details=None):
    con.execute(
        "INSERT INTO audit_log (at, user_id, user_login, action, entity, entity_id, details) VALUES (?,?,?,?,?,?,?)",
        (
            now(),
            user["id"] if user else None,
            user["login"] if user else None,
            action,
            entity,
            None if entity_id is None else str(entity_id),
            json.dumps(details, ensure_ascii=False, default=str) if details is not None else None,
        ),
    )


# Колонки, добавленные после первого выпуска: в существующей базе их создаём ALTER TABLE.
MIGRATIONS = {
    "map_object": [("contract_number", "TEXT"), ("cadastral_number", "TEXT")],
}


def migrate(con):
    for table, columns in MIGRATIONS.items():
        have = {r["name"] for r in con.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns:
            if name not in have:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
    con.execute("CREATE INDEX IF NOT EXISTS idx_obj_cadastral ON map_object(cadastral_number)")


def init_db():
    from .auth import hash_password

    con = connect()
    try:
        con.executescript(SCHEMA)
        migrate(con)
        if con.execute("SELECT COUNT(*) FROM user").fetchone()[0] == 0:
            password = secrets.token_urlsafe(12)
            con.execute(
                "INSERT INTO user (login, password_hash, role, full_name, created_at) VALUES (?,?,?,?,?)",
                ("admin", hash_password(password), "admin", "Администратор", now()),
            )
            path = DATA_DIR / "initial_admin_password.txt"
            path.write_text(f"login: admin\npassword: {password}\n")
            path.chmod(0o600)
        if con.execute("SELECT COUNT(*) FROM object_type").fetchone()[0] == 0:
            con.executemany(
                "INSERT INTO object_type (code, name, icon, color, has_radius, default_radius_m, fill_opacity, sort_order)"
                " VALUES (?,?,?,?,?,?,?,?)",
                [
                    ("tower", "Вышка связи", "tower", "#1e88e5", 1, 1000, 0.2, 1),
                    ("office", "Офис", "house", "#43a047", 0, None, 0.2, 2),
                    ("warehouse", "Склад", "square", "#8e24aa", 1, 300, 0.25, 3),
                    ("incident", "Инцидент", "warning", "#e53935", 1, 200, 0.3, 4),
                ],
            )
    finally:
        con.close()
