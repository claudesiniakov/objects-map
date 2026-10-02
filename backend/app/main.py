import json
import re
import secrets
from datetime import datetime
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, field_validator

from . import excel, importer
from .auth import (check_password, client_ip, current_user, hash_password, login_blocked, make_token,
                   register_failed_login, require)
from .config import ICON_DIR, IMPORT_DIR, MAX_RADIUS_M, MAX_UPLOAD_MB
from .db import DataVersion, audit, get_db, get_settings, init_db, now, search_text, tx

app = FastAPI(title="Карта объектов", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)


@app.on_event("startup")
def _startup():
    init_db()


XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
CODE_RE = re.compile(r"^[A-Za-z0-9_\-а-яА-ЯёЁ]{1,50}$")
BUILTIN_ICONS = ["circle", "square", "triangle", "diamond", "star", "plus", "hexagon", "flag", "house",
                 "tower", "drop", "bolt", "warning", "tree", "car", "factory"]


def xlsx_response(data: bytes, filename: str) -> Response:
    from urllib.parse import quote

    return Response(
        data,
        media_type=XLSX,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )


def row_or_404(db, sql, params, what="Объект"):
    row = db.execute(sql, params).fetchone()
    if not row:
        raise HTTPException(404, f"{what} не найден")
    return row


# ---------------------------------------------------------------- авторизация


class LoginIn(BaseModel):
    login: str
    password: str


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request, db=Depends(get_db)):
    ip = client_ip(request)
    if login_blocked(ip):
        raise HTTPException(429, "Слишком много неудачных попыток, подождите 10 минут")
    user = db.execute("SELECT * FROM user WHERE login = ? AND active = 1", (body.login.strip(),)).fetchone()
    if not user or not check_password(body.password, user["password_hash"]):
        register_failed_login(ip)
        raise HTTPException(401, "Неверный логин или пароль")
    audit(db, user, "login", "user", user["id"], {"ip": ip})
    return {"token": make_token(user), "user": public_user(user)}


def public_user(u) -> dict:
    return {k: u[k] for k in ("id", "login", "role", "full_name", "active", "created_at")}


@app.get("/api/auth/me")
def me(user=Depends(current_user)):
    return public_user(user)


class PasswordIn(BaseModel):
    old_password: str
    new_password: str = Field(min_length=8)


@app.post("/api/auth/password")
def change_password(body: PasswordIn, user=Depends(current_user), db=Depends(get_db)):
    if not check_password(body.old_password, user["password_hash"]):
        raise HTTPException(400, "Текущий пароль указан неверно")
    db.execute("UPDATE user SET password_hash = ? WHERE id = ?", (hash_password(body.new_password), user["id"]))
    audit(db, user, "password", "user", user["id"])
    return {"ok": True}


# ---------------------------------------------------------------- настройки


class SettingsIn(BaseModel):
    center_lat: float = Field(ge=-90, le=90)
    center_lon: float = Field(ge=-180, le=180)
    zoom: float = Field(ge=0, le=20)
    cluster_radius: int = Field(ge=10, le=200)
    cluster_max_zoom: int = Field(ge=5, le=20)


@app.get("/api/settings")
def read_settings(user=Depends(current_user), db=Depends(get_db)):
    return get_settings(db)


@app.put("/api/settings")
def write_settings(body: SettingsIn, user=Depends(require("admin")), db=Depends(get_db)):
    with tx(db):
        for k, v in body.model_dump().items():
            db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, json.dumps(v)))
        audit(db, user, "update", "settings", None, body.model_dump())
    return get_settings(db)


# ---------------------------------------------------------------- типы


class TypeIn(BaseModel):
    code: str
    name: str = Field(min_length=1, max_length=255)
    icon: str = "circle"
    color: str = "#1e88e5"
    has_radius: bool = False
    default_radius_m: int | None = Field(default=None, ge=1, le=MAX_RADIUS_M)
    fill_opacity: float = Field(default=0.2, ge=0.05, le=0.8)
    sort_order: int = 0
    visible_default: bool = True

    @field_validator("code")
    @classmethod
    def _code(cls, v):
        v = v.strip()
        if not CODE_RE.match(v):
            raise ValueError("Код: буквы, цифры, «_» и «-», до 50 символов")
        return v

    @field_validator("color")
    @classmethod
    def _color(cls, v):
        if not COLOR_RE.match(v):
            raise ValueError("Цвет в формате #RRGGBB")
        return v.lower()


def type_dict(row) -> dict:
    d = dict(row)
    d["has_radius"] = bool(d["has_radius"])
    d["visible_default"] = bool(d["visible_default"])
    return d


@app.get("/api/types")
def list_types(user=Depends(current_user), db=Depends(get_db)):
    rows = db.execute(
        "SELECT t.*, (SELECT COUNT(*) FROM map_object o WHERE o.type_id = t.id) AS objects"
        " FROM object_type t ORDER BY t.sort_order, t.name"
    ).fetchall()
    return [type_dict(r) for r in rows]


def _check_icon(icon: str):
    if icon in BUILTIN_ICONS:
        return
    if icon.startswith("upload:") and (ICON_DIR / icon[7:]).is_file():
        return
    raise HTTPException(422, "Неизвестная иконка")


def _save_type(db, body: TypeIn, type_id=None):
    _check_icon(body.icon)
    if body.has_radius and not body.default_radius_m:
        raise HTTPException(422, "Для типа с зоной укажите радиус по умолчанию")
    clash = db.execute(
        "SELECT id FROM object_type WHERE (lower(code) = lower(?) OR lower(name) = lower(?)) AND id IS NOT ?",
        (body.code, body.name, type_id),
    ).fetchone()
    if clash:
        raise HTTPException(409, "Тип с таким кодом или названием уже есть")
    v = body.model_dump()
    cols = ["code", "name", "icon", "color", "has_radius", "default_radius_m", "fill_opacity", "sort_order",
            "visible_default"]
    vals = [v[c] for c in cols]
    if type_id is None:
        cur = db.execute(f"INSERT INTO object_type ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", vals)
        return cur.lastrowid
    db.execute(f"UPDATE object_type SET {', '.join(c + '=?' for c in cols)} WHERE id = ?", vals + [type_id])
    return type_id


@app.post("/api/types")
def create_type(body: TypeIn, user=Depends(require("admin")), db=Depends(get_db)):
    with tx(db):
        tid = _save_type(db, body)
        audit(db, user, "create", "object_type", tid, body.model_dump())
    DataVersion.bump()
    return type_dict(db.execute("SELECT * FROM object_type WHERE id = ?", (tid,)).fetchone())


@app.put("/api/types/{type_id}")
def update_type(type_id: int, body: TypeIn, user=Depends(require("admin")), db=Depends(get_db)):
    row_or_404(db, "SELECT id FROM object_type WHERE id = ?", (type_id,), "Тип")
    with tx(db):
        _save_type(db, body, type_id)
        audit(db, user, "update", "object_type", type_id, body.model_dump())
    DataVersion.bump()
    return type_dict(db.execute("SELECT * FROM object_type WHERE id = ?", (type_id,)).fetchone())


@app.delete("/api/types/{type_id}")
def delete_type(type_id: int, user=Depends(require("admin")), db=Depends(get_db)):
    t = row_or_404(db, "SELECT * FROM object_type WHERE id = ?", (type_id,), "Тип")
    n = db.execute("SELECT COUNT(*) FROM map_object WHERE type_id = ?", (type_id,)).fetchone()[0]
    if n:
        raise HTTPException(409, f"Нельзя удалить тип: к нему относятся объекты ({n})")
    with tx(db):
        db.execute("DELETE FROM object_type WHERE id = ?", (type_id,))
        audit(db, user, "delete", "object_type", type_id, {"code": t["code"], "name": t["name"]})
    DataVersion.bump()
    return {"ok": True}


# ---------------------------------------------------------------- иконки


@app.get("/api/icons")
def list_icons(user=Depends(current_user)):
    uploaded = sorted(p.name for p in ICON_DIR.iterdir() if p.is_file())
    return {"builtin": BUILTIN_ICONS, "uploaded": ["upload:" + n for n in uploaded]}


@app.get("/api/icons/file/{name}")
def icon_file(name: str):
    path = (ICON_DIR / name).resolve()
    if path.parent != ICON_DIR.resolve() or not path.is_file():
        raise HTTPException(404, "Иконка не найдена")
    media = "image/svg+xml" if path.suffix == ".svg" else "image/png"
    # SVG отдаём с запретом скриптов: файл загружает пользователь.
    return FileResponse(path, media_type=media, headers={"Content-Security-Policy": "script-src 'none'",
                                                         "Cache-Control": "public, max-age=86400"})


@app.post("/api/icons")
async def upload_icon(file: UploadFile = File(...), user=Depends(require("admin")), db=Depends(get_db)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in (".svg", ".png"):
        raise HTTPException(422, "Иконка должна быть в формате SVG или PNG")
    data = await file.read()
    if len(data) > 512 * 1024:
        raise HTTPException(422, "Иконка больше 512 КБ")
    if suffix == ".png" and not data.startswith(b"\x89PNG"):
        raise HTTPException(422, "Файл не похож на PNG")
    if suffix == ".svg":
        text = data.decode("utf-8", "ignore").lower()
        if "<svg" not in text or "<script" in text or "javascript:" in text:
            raise HTTPException(422, "Некорректный SVG")
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(file.filename).stem)[:40].strip("-") or "icon"
    name = f"{stem}-{secrets.token_hex(3)}{suffix}"
    (ICON_DIR / name).write_bytes(data)
    audit(db, user, "upload", "icon", name)
    return {"icon": "upload:" + name}


# ---------------------------------------------------------------- объекты: карта


_map_cache: dict = {}


def effective_radius_sql() -> str:
    return "CASE WHEN t.has_radius THEN COALESCE(o.radius_m, t.default_radius_m) END"


@app.get("/api/objects")
def map_objects(
    bbox: str | None = Query(None, description="minLon,minLat,maxLon,maxLat"),
    types: str | None = Query(None, description="id типов через запятую"),
    source: str | None = None,
    user=Depends(current_user),
    db=Depends(get_db),
):
    """Объекты в формате GeoJSON (компактные свойства: id, t — тип, n — название, r — радиус, s — источник)."""
    key = (DataVersion.value, bbox, types, source)
    cached = _map_cache.get(key)
    if cached is None:
        where, params = [], []
        if bbox:
            try:
                x1, y1, x2, y2 = (float(v) for v in bbox.split(","))
            except ValueError:
                raise HTTPException(422, "bbox: minLon,minLat,maxLon,maxLat")
            where.append("o.lat BETWEEN ? AND ? AND o.lon BETWEEN ? AND ?")
            params += [y1, y2, x1, x2]
        if types:
            ids = [int(v) for v in types.split(",") if v.strip().isdigit()]
            where.append(f"o.type_id IN ({','.join('?' * len(ids)) or 'NULL'})")
            params += ids
        if source:
            where.append("o.source = ?")
            params.append(source)
        sql = (f"SELECT o.id, o.type_id, o.name, o.lat, o.lon, o.source, {effective_radius_sql()} AS r"
               " FROM map_object o JOIN object_type t ON t.id = o.type_id")
        if where:
            sql += " WHERE " + " AND ".join(where)
        feats = [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [r[4], r[3]]},
             "properties": {"id": r[0], "t": r[1], "n": r[2], "s": r[5], "r": r[6]}}
            for r in db.execute(sql, params)
        ]
        cached = json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False,
                            separators=(",", ":")).encode()
        if len(_map_cache) > 20:
            _map_cache.clear()
        _map_cache[key] = cached
    return Response(cached, media_type="application/json", headers={"Cache-Control": "no-cache"})


def object_dict(row) -> dict:
    d = dict(row)
    d.pop("search_text", None)
    d["attributes"] = json.loads(d["attributes"] or "{}")
    return d


OBJECT_SELECT = (
    "SELECT o.*, t.name AS type_name, t.code AS type_code, t.color AS type_color, t.icon AS type_icon,"
    f" {effective_radius_sql()} AS effective_radius_m, b.file_name AS import_file, b.committed_at AS import_at"
    " FROM map_object o JOIN object_type t ON t.id = o.type_id LEFT JOIN import_batch b ON b.id = o.import_id"
)


@app.get("/api/objects/{object_id}")
def get_object(object_id: int, user=Depends(current_user), db=Depends(get_db)):
    return object_dict(row_or_404(db, OBJECT_SELECT + " WHERE o.id = ?", (object_id,)))


@app.get("/api/search")
def search(q: str = Query(min_length=1), user=Depends(current_user), db=Depends(get_db)):
    like = f"%{q.strip().lower()}%"
    rows = db.execute(
        "SELECT o.id, o.name, o.address, o.lat, o.lon, o.type_id, t.name AS type_name FROM map_object o"
        " JOIN object_type t ON t.id = o.type_id WHERE o.search_text LIKE ? ORDER BY o.name LIMIT 20",
        (like,),
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/sources")
def sources(user=Depends(current_user), db=Depends(get_db)):
    rows = db.execute(
        "SELECT source, COUNT(*) AS objects FROM map_object WHERE source IS NOT NULL GROUP BY source ORDER BY source"
    ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- объекты: управление


class ObjectIn(BaseModel):
    external_id: str | None = None
    type_id: int
    name: str = Field(min_length=1, max_length=500)
    address: str | None = None
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius_m: int | None = Field(default=None, ge=1, le=MAX_RADIUS_M)
    description: str | None = None
    attributes: dict = {}
    source: str | None = None

    @field_validator("external_id", "address", "description", "source")
    @classmethod
    def _blank(cls, v):
        if v is None:
            return None
        v = v.strip()
        return v or None


def _save_object(db, body: ObjectIn, object_id=None):
    row_or_404(db, "SELECT id FROM object_type WHERE id = ?", (body.type_id,), "Тип")
    if body.external_id:
        clash = db.execute("SELECT id FROM map_object WHERE external_id = ? AND id IS NOT ?",
                           (body.external_id, object_id)).fetchone()
        if clash:
            raise HTTPException(409, f"ID «{body.external_id}» уже занят другим объектом")
    ts = now()
    vals = (body.external_id, body.type_id, body.name.strip(), body.address, body.lat, body.lon, body.radius_m,
            body.description, json.dumps(body.attributes, ensure_ascii=False), body.source,
            search_text(body.name, body.address, body.external_id))
    if object_id is None:
        cur = db.execute(
            "INSERT INTO map_object (external_id, type_id, name, address, lat, lon, radius_m, description, attributes,"
            " source, search_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            vals + (ts, ts),
        )
        return cur.lastrowid
    db.execute(
        "UPDATE map_object SET external_id=?, type_id=?, name=?, address=?, lat=?, lon=?, radius_m=?, description=?,"
        " attributes=?, source=?, search_text=?, updated_at=? WHERE id=?",
        vals + (ts, object_id),
    )
    return object_id


SORTABLE = {"id": "o.id", "name": "o.name", "type": "t.name", "external_id": "o.external_id",
            "updated_at": "o.updated_at", "source": "o.source", "radius_m": "o.radius_m"}


def _object_filter(q, type_id, source, import_id):
    where, params = [], []
    if q:
        where.append("o.search_text LIKE ?")
        params.append(f"%{q.strip().lower()}%")
    if type_id:
        where.append("o.type_id = ?")
        params.append(type_id)
    if source:
        where.append("o.source = ?")
        params.append(source)
    if import_id:
        where.append("o.import_id = ?")
        params.append(import_id)
    return (" WHERE " + " AND ".join(where)) if where else "", params


@app.get("/api/admin/objects")
def admin_objects(
    q: str | None = None,
    type_id: int | None = None,
    source: str | None = None,
    import_id: int | None = None,
    sort: str = "id",
    order: str = "desc",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    user=Depends(require("operator")),
    db=Depends(get_db),
):
    where, params = _object_filter(q, type_id, source, import_id)
    total = db.execute(
        "SELECT COUNT(*) FROM map_object o JOIN object_type t ON t.id = o.type_id" + where, params
    ).fetchone()[0]
    order_sql = f"{SORTABLE.get(sort, 'o.id')} {'ASC' if order == 'asc' else 'DESC'}, o.id DESC"
    rows = db.execute(
        OBJECT_SELECT + where + f" ORDER BY {order_sql} LIMIT ? OFFSET ?",
        params + [page_size, (page - 1) * page_size],
    ).fetchall()
    return {"total": total, "items": [object_dict(r) for r in rows]}


@app.post("/api/objects")
def create_object(body: ObjectIn, user=Depends(require("operator")), db=Depends(get_db)):
    with tx(db):
        oid = _save_object(db, body)
        audit(db, user, "create", "map_object", oid, body.model_dump())
    DataVersion.bump()
    return get_object(oid, user, db)


@app.put("/api/objects/{object_id}")
def update_object(object_id: int, body: ObjectIn, user=Depends(require("operator")), db=Depends(get_db)):
    before = object_dict(row_or_404(db, "SELECT * FROM map_object WHERE id = ?", (object_id,)))
    with tx(db):
        _save_object(db, body, object_id)
        after = body.model_dump()
        diff = {k: [before.get(k), v] for k, v in after.items() if before.get(k) != v}
        audit(db, user, "update", "map_object", object_id, diff)
    DataVersion.bump()
    return get_object(object_id, user, db)


@app.delete("/api/objects/{object_id}")
def delete_object(object_id: int, user=Depends(require("operator")), db=Depends(get_db)):
    before = object_dict(row_or_404(db, "SELECT * FROM map_object WHERE id = ?", (object_id,)))
    with tx(db):
        db.execute("DELETE FROM map_object WHERE id = ?", (object_id,))
        audit(db, user, "delete", "map_object", object_id, before)
    DataVersion.bump()
    return {"ok": True}


class BulkIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=100_000)
    type_id: int | None = None


@app.post("/api/objects/bulk-delete")
def bulk_delete(body: BulkIn, user=Depends(require("operator")), db=Depends(get_db)):
    with tx(db):
        n = 0
        for chunk in range(0, len(body.ids), 900):
            part = body.ids[chunk:chunk + 900]
            n += db.execute(f"DELETE FROM map_object WHERE id IN ({','.join('?' * len(part))})", part).rowcount
        audit(db, user, "bulk_delete", "map_object", None, {"ids": body.ids[:1000], "deleted": n})
    DataVersion.bump()
    return {"deleted": n}


@app.post("/api/objects/bulk-type")
def bulk_type(body: BulkIn, user=Depends(require("operator")), db=Depends(get_db)):
    if not body.type_id:
        raise HTTPException(422, "Укажите новый тип")
    row_or_404(db, "SELECT id FROM object_type WHERE id = ?", (body.type_id,), "Тип")
    with tx(db):
        n = 0
        for chunk in range(0, len(body.ids), 900):
            part = body.ids[chunk:chunk + 900]
            n += db.execute(
                f"UPDATE map_object SET type_id = ?, updated_at = ? WHERE id IN ({','.join('?' * len(part))})",
                [body.type_id, now()] + part,
            ).rowcount
        audit(db, user, "bulk_type", "map_object", None, {"ids": body.ids[:1000], "type_id": body.type_id, "updated": n})
    DataVersion.bump()
    return {"updated": n}


@app.get("/api/export")
def export(
    q: str | None = None,
    type_id: int | None = None,
    types: str | None = None,
    source: str | None = None,
    import_id: int | None = None,
    user=Depends(require("operator")),
    db=Depends(get_db),
):
    where, params = _object_filter(q, type_id, source, import_id)
    if types:
        ids = [int(v) for v in types.split(",") if v.strip().isdigit()]
        where += (" AND " if where else " WHERE ") + f"o.type_id IN ({','.join('?' * len(ids)) or 'NULL'})"
        params += ids
    rows = [object_dict(r) for r in db.execute(OBJECT_SELECT + where + " ORDER BY o.id", params)]
    stamp = datetime.now().strftime("%Y-%m-%d_%H-%M")
    return xlsx_response(excel.build_export(rows), f"objects_{stamp}.xlsx")


# ---------------------------------------------------------------- импорт


def batch_dict(row) -> dict:
    d = dict(row)
    d["mapping"] = json.loads(d["mapping"]) if d["mapping"] else None
    return d


@app.get("/api/import/template")
def import_template(user=Depends(require("operator")), db=Depends(get_db)):
    types = [dict(r) for r in db.execute("SELECT * FROM object_type ORDER BY sort_order, name")]
    return xlsx_response(excel.build_template(types), "shablon_importa.xlsx")


@app.get("/api/import")
def import_history(user=Depends(require("operator")), db=Depends(get_db)):
    rows = db.execute(
        "SELECT * FROM import_batch WHERE status IN ('committed', 'rolled_back') ORDER BY id DESC LIMIT 200"
    ).fetchall()
    latest = db.execute("SELECT MAX(id) FROM import_batch WHERE status = 'committed'").fetchone()[0]
    out = []
    for r in rows:
        d = batch_dict(r)
        d["can_rollback"] = d["id"] == latest
        out.append(d)
    return out


@app.post("/api/import")
async def import_upload(file: UploadFile = File(...), user=Depends(require("operator")), db=Depends(get_db)):
    """Шаг 1: загрузка файла. Возвращает листы, колонки и предложенное сопоставление."""
    name = Path(file.filename or "file").name
    suffix = Path(name).suffix.lower()
    if suffix not in (".xlsx", ".xlsm", ".xls", ".csv"):
        raise HTTPException(422, "Поддерживаются файлы .xlsx, .xls и .csv")
    data = await file.read(MAX_UPLOAD_MB * 1024 * 1024 + 1)
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"Файл больше {MAX_UPLOAD_MB} МБ")
    stored = f"{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(4)}{suffix}"
    (IMPORT_DIR / stored).write_bytes(data)
    try:
        table = importer.load_table(stored)
    except excel.TableError as e:
        (IMPORT_DIR / stored).unlink(missing_ok=True)
        raise HTTPException(422, str(e))
    sheets = [
        {"name": sname, "headers": t["headers"], "rows": len(t["rows"]),
         "suggested_mapping": importer.suggest_mapping(t["headers"]),
         "sample": [v for _, v in t["rows"][:5]]}
        for sname, t in table.items()
    ]
    if not any(s["rows"] for s in sheets):
        raise HTTPException(422, "В файле нет строк с данными")
    cur = db.execute(
        "INSERT INTO import_batch (file_name, stored_file, source, user_id, user_login, created_at, status)"
        " VALUES (?,?,?,?,?,?, 'uploaded')",
        (name, stored, Path(name).stem, user["id"], user["login"], now()),
    )
    return {"id": cur.lastrowid, "file_name": name, "source": Path(name).stem, "sheets": sheets,
            "fields": importer.FIELDS, "required": importer.REQUIRED}


class PreviewIn(BaseModel):
    sheet: str
    mapping: dict[str, str]
    mode: str = "upsert"
    source: str = Field(min_length=1, max_length=255)


def _pending_batch(db, import_id):
    b = row_or_404(db, "SELECT * FROM import_batch WHERE id = ?", (import_id,), "Импорт")
    if b["status"] not in ("uploaded", "checked"):
        raise HTTPException(409, "Этот импорт уже выполнен")
    return dict(b)


def _validate_batch(db, b: dict, body: PreviewIn):
    try:
        table = importer.load_table(b["stored_file"])
    except excel.TableError as e:
        raise HTTPException(422, str(e))
    if body.sheet not in table:
        raise HTTPException(422, "Лист не найден")
    result = importer.validate(db, table[body.sheet], body.mapping, body.mode, body.source.strip())
    if "fatal" in result:
        raise HTTPException(422, "; ".join(result["fatal"]))
    return table[body.sheet], result


@app.post("/api/import/{import_id}/preview")
def import_preview(import_id: int, body: PreviewIn, user=Depends(require("operator")), db=Depends(get_db)):
    """Шаг 2: проверка строк и предпросмотр. В базу объектов ничего не пишется."""
    b = _pending_batch(db, import_id)
    _, result = _validate_batch(db, b, body)
    db.execute(
        "UPDATE import_batch SET status='checked', sheet=?, mapping=?, mode=?, source=? WHERE id=?",
        (body.sheet, json.dumps(body.mapping, ensure_ascii=False), body.mode, body.source.strip(), import_id),
    )
    return importer.preview_payload(result)


@app.post("/api/import/{import_id}/commit")
def import_commit(import_id: int, user=Depends(require("operator")), db=Depends(get_db)):
    """Шаг 3: запись проверенных строк в базу одной транзакцией."""
    b = _pending_batch(db, import_id)
    if b["status"] != "checked":
        raise HTTPException(409, "Сначала выполните проверку файла")
    body = PreviewIn(sheet=b["sheet"], mapping=json.loads(b["mapping"]), mode=b["mode"], source=b["source"])
    _, result = _validate_batch(db, b, body)
    if result["counts"]["create"] + result["counts"]["update"] + result["counts"]["delete"] == 0:
        raise HTTPException(422, "Нет строк для загрузки — исправьте ошибки в файле")
    return importer.commit(db, b, result, user)


@app.post("/api/import/{import_id}/rollback")
def import_rollback(import_id: int, user=Depends(require("operator")), db=Depends(get_db)):
    b = dict(row_or_404(db, "SELECT * FROM import_batch WHERE id = ?", (import_id,), "Импорт"))
    if b["status"] != "committed":
        raise HTTPException(409, "Откатить можно только выполненный импорт")
    latest = db.execute("SELECT MAX(id) FROM import_batch WHERE status = 'committed'").fetchone()[0]
    if latest != import_id:
        raise HTTPException(409, "Откатывать импорты можно только по порядку, начиная с последнего")
    return importer.rollback(db, b, user)


@app.get("/api/import/{import_id}/errors")
def import_errors(import_id: int, user=Depends(require("operator")), db=Depends(get_db)):
    b = dict(row_or_404(db, "SELECT * FROM import_batch WHERE id = ?", (import_id,), "Импорт"))
    if not b["mapping"]:
        raise HTTPException(409, "Файл ещё не проверялся")
    body = PreviewIn(sheet=b["sheet"], mapping=json.loads(b["mapping"]), mode=b["mode"] or "upsert",
                     source=b["source"])
    if b["status"] in ("uploaded", "checked"):
        sheet, result = _validate_batch(db, b, body)
    else:
        # После записи объекты уже в базе: проверяем только содержимое файла, без сверки с базой.
        table = importer.load_table(b["stored_file"])
        sheet = table[b["sheet"]]
        result = importer.validate(db, sheet, body.mapping, "add" if body.mode == "add" else "upsert", body.source)
        for r in result["rows"]:
            r["errors"] = [e for e in r["errors"] if "уже есть в базе" not in e]
    rows = [r for r in result["rows"] if r["errors"] or r["warnings"]]
    return xlsx_response(excel.build_error_report(sheet["headers"], rows), f"oshibki_importa_{import_id}.xlsx")


@app.get("/api/import/{import_id}/file")
def import_file(import_id: int, user=Depends(require("operator")), db=Depends(get_db)):
    b = row_or_404(db, "SELECT * FROM import_batch WHERE id = ?", (import_id,), "Импорт")
    path = IMPORT_DIR / b["stored_file"]
    if not path.is_file():
        raise HTTPException(404, "Исходный файл не сохранился")
    return FileResponse(path, filename=b["file_name"])


class MappingIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    mapping: dict[str, str]


@app.get("/api/import/mappings")
def list_mappings(user=Depends(require("operator")), db=Depends(get_db)):
    return [{"id": r["id"], "name": r["name"], "mapping": json.loads(r["mapping"])}
            for r in db.execute("SELECT * FROM mapping_template ORDER BY name")]


@app.post("/api/import/mappings")
def save_mapping(body: MappingIn, user=Depends(require("operator")), db=Depends(get_db)):
    db.execute("INSERT OR REPLACE INTO mapping_template (name, mapping) VALUES (?, ?)",
               (body.name.strip(), json.dumps(body.mapping, ensure_ascii=False)))
    return {"ok": True}


@app.delete("/api/import/mappings/{mapping_id}")
def delete_mapping(mapping_id: int, user=Depends(require("operator")), db=Depends(get_db)):
    db.execute("DELETE FROM mapping_template WHERE id = ?", (mapping_id,))
    return {"ok": True}


# ---------------------------------------------------------------- пользователи


class UserIn(BaseModel):
    login: str = Field(min_length=2, max_length=64, pattern=r"^[A-Za-z0-9_.\-@]+$")
    full_name: str | None = None
    role: str = Field(pattern="^(viewer|operator|admin)$")
    active: bool = True
    password: str | None = Field(default=None, min_length=8)


@app.get("/api/users")
def list_users(user=Depends(require("admin")), db=Depends(get_db)):
    return [public_user(r) for r in db.execute("SELECT * FROM user ORDER BY login")]


@app.post("/api/users")
def create_user(body: UserIn, user=Depends(require("admin")), db=Depends(get_db)):
    if not body.password:
        raise HTTPException(422, "Задайте пароль (не короче 8 символов)")
    if db.execute("SELECT 1 FROM user WHERE login = ?", (body.login,)).fetchone():
        raise HTTPException(409, "Такой логин уже есть")
    with tx(db):
        cur = db.execute(
            "INSERT INTO user (login, password_hash, role, full_name, active, created_at) VALUES (?,?,?,?,?,?)",
            (body.login, hash_password(body.password), body.role, body.full_name, int(body.active), now()),
        )
        audit(db, user, "create", "user", cur.lastrowid, {"login": body.login, "role": body.role})
    return public_user(db.execute("SELECT * FROM user WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.put("/api/users/{user_id}")
def update_user(user_id: int, body: UserIn, user=Depends(require("admin")), db=Depends(get_db)):
    row_or_404(db, "SELECT id FROM user WHERE id = ?", (user_id,), "Пользователь")
    if user_id == user["id"] and (body.role != "admin" or not body.active):
        raise HTTPException(409, "Нельзя снять с себя права администратора или отключить себя")
    if db.execute("SELECT 1 FROM user WHERE login = ? AND id != ?", (body.login, user_id)).fetchone():
        raise HTTPException(409, "Такой логин уже есть")
    with tx(db):
        db.execute("UPDATE user SET login=?, full_name=?, role=?, active=? WHERE id=?",
                   (body.login, body.full_name, body.role, int(body.active), user_id))
        if body.password:
            db.execute("UPDATE user SET password_hash=? WHERE id=?", (hash_password(body.password), user_id))
        audit(db, user, "update", "user", user_id,
              {"login": body.login, "role": body.role, "active": body.active, "password_changed": bool(body.password)})
    return public_user(db.execute("SELECT * FROM user WHERE id = ?", (user_id,)).fetchone())


@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, user=Depends(require("admin")), db=Depends(get_db)):
    if user_id == user["id"]:
        raise HTTPException(409, "Нельзя удалить себя")
    u = row_or_404(db, "SELECT * FROM user WHERE id = ?", (user_id,), "Пользователь")
    with tx(db):
        db.execute("UPDATE import_batch SET user_id = NULL WHERE user_id = ?", (user_id,))
        db.execute("DELETE FROM user WHERE id = ?", (user_id,))
        audit(db, user, "delete", "user", user_id, {"login": u["login"]})
    return {"ok": True}


# ---------------------------------------------------------------- журнал


@app.get("/api/audit")
def audit_log(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    entity: str | None = None,
    user=Depends(require("operator")),
    db=Depends(get_db),
):
    where, params = "", []
    if entity:
        where, params = " WHERE entity = ?", [entity]
    total = db.execute("SELECT COUNT(*) FROM audit_log" + where, params).fetchone()[0]
    rows = db.execute(
        "SELECT * FROM audit_log" + where + " ORDER BY id DESC LIMIT ? OFFSET ?",
        params + [page_size, (page - 1) * page_size],
    ).fetchall()
    items = []
    for r in rows:
        d = dict(r)
        d["details"] = json.loads(d["details"]) if d["details"] else None
        items.append(d)
    return {"total": total, "items": items}


@app.get("/api/health")
def health(db=Depends(get_db)):
    n = db.execute("SELECT COUNT(*) FROM map_object").fetchone()[0]
    return {"ok": True, "objects": n}
