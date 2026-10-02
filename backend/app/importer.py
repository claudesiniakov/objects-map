"""Проверка строк импорта и запись в базу одной транзакцией с возможностью отката."""

import json
import math
import re
import statistics
from collections import Counter, OrderedDict
from datetime import date, datetime
from pathlib import Path

from .config import IMPORT_DIR, MAX_RADIUS_M
from .db import DataVersion, audit, now, search_text, tx
from .excel import read_table
from .geo import GeometryError, dumps as geometry_dumps, label_point, parse_geometry

FIELDS = OrderedDict(
    [
        ("external_id", "ID"),
        ("contract_number", "Номер договора"),
        ("cadastral_number", "Кадастровый номер"),
        ("cost", "Стоимость, тыс. руб."),
        ("geometry", "Геометрия (GeoJSON)"),
        ("type", "Тип"),
        ("name", "Название"),
        ("lat", "Широта"),
        ("lon", "Долгота"),
        ("address", "Адрес"),
        ("radius_m", "Радиус, м"),
        ("description", "Описание"),
    ]
)
REQUIRED = ("type", "name", "lat", "lon")
# Кадастровый номер РФ: округ:район:квартал:участок, например 77:01:0001001:1234.
CADASTRAL_RE = re.compile(r"^\d{2}:\d{2}:\d{6,7}:\d+$")
MODES = ("add", "upsert", "replace")

SYNONYMS = {
    "external_id": ["id", "ид", "внешний id", "внешний ид", "код объекта", "external_id"],
    "contract_number": ["номер договора", "№ договора", "договор", "договор №", "номер контракта", "contract",
                        "contract_number"],
    "cadastral_number": ["кадастровый номер", "кадастровый №", "кад. номер", "кадастр", "кн", "cadastral_number",
                         "cadastral number"],
    "cost": ["стоимость", "стоимость, тыс. руб.", "стоимость, тыс. руб", "стоимость (тыс. руб.)", "стоимость тыс. руб.",
             "стоимость тыс руб", "стоимость, тыс.", "цена", "cost"],
    "geometry": ["геометрия (geojson)", "геометрия", "geometry", "geojson", "контур"],
    "type": ["тип", "type", "тип объекта", "вид"],
    "name": ["название", "наименование", "name", "имя", "объект"],
    "lat": ["широта", "lat", "latitude", "y", "широта (lat)", "широта (центр)"],
    "lon": ["долгота", "lon", "lng", "long", "longitude", "x", "долгота (lon)", "долгота (центр)"],
    "address": ["адрес", "address", "местоположение"],
    "radius_m": ["радиус", "радиус, м", "радиус (м)", "радиус м", "radius", "radius_m", "радиус зоны"],
    "description": ["описание", "description", "комментарий", "примечание"],
}

# Распарсенные файлы держим в памяти: превью и запись идут по одному файлу подряд.
_table_cache: "OrderedDict[str, dict]" = OrderedDict()


def load_table(stored_file: str) -> dict:
    if stored_file in _table_cache:
        _table_cache.move_to_end(stored_file)
        return _table_cache[stored_file]
    table = read_table(IMPORT_DIR / stored_file)
    _table_cache[stored_file] = table
    while len(_table_cache) > 3:
        _table_cache.popitem(last=False)
    return table


def suggest_mapping(headers: list[str]) -> dict:
    mapping, used = {}, set()
    for h in headers:
        key = h.strip().lower()
        field = next((f for f, syn in SYNONYMS.items() if key in syn and f not in used), None)
        if field:
            used.add(field)
            mapping[h] = field
        else:
            mapping[h] = "attr"
    return mapping


def _num(v):
    if v is None:
        return None
    if isinstance(v, bool):
        raise ValueError
    if isinstance(v, (int, float)):
        if math.isnan(v):
            return None
        return float(v)
    s = str(v).strip().replace(" ", "").replace(" ", "").replace(",", ".")
    if s == "":
        return None
    return float(s)


def _text(v):
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if isinstance(v, (datetime, date)):
        v = v.isoformat()
    s = str(v).strip()
    return s or None


def _attr_value(v):
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def validate(db, table: dict, mapping: dict, mode: str, source: str) -> dict:
    """Проверяет строки и решает, что с каждой будет сделано. В базу ничего не пишет."""
    headers = table["headers"]
    problems = []
    if mode not in MODES:
        problems.append("Неизвестный режим импорта")
    by_field = {}
    for h in headers:
        f = mapping.get(h, "attr")
        if f in FIELDS:
            if f in by_field:
                problems.append(f"Поле «{FIELDS[f]}» сопоставлено двум колонкам")
            by_field[f] = headers.index(h)
    for f in REQUIRED:
        # С колонкой геометрии координаты не обязательны — маркер ставится посередине полигона.
        if f not in by_field and not (f in ("lat", "lon") and "geometry" in by_field):
            problems.append(f"Не выбрана колонка для обязательного поля «{FIELDS[f]}»")
    if mode == "upsert" and "external_id" not in by_field:
        problems.append("Для режима «Обновить / добавить» нужна колонка ID")
    if problems:
        return {"fatal": problems}

    attr_cols = [(i, h) for i, h in enumerate(headers) if mapping.get(h, "attr") == "attr"]

    types = [dict(r) for r in db.execute("SELECT id, code, name, has_radius FROM object_type")]
    type_index = {}
    for t in types:
        type_index[t["code"].lower()] = t
        type_index[t["name"].lower()] = t

    existing = {
        r["external_id"]: (r["id"], r["source"])
        for r in db.execute("SELECT id, external_id, source FROM map_object WHERE external_id IS NOT NULL")
    }

    def col(values, field):
        i = by_field.get(field)
        return values[i] if i is not None else None

    rows, unknown_types = [], Counter()
    ext_counter = Counter()
    for rownum, values in table["rows"]:
        errors, warnings = [], []
        ext = _text(col(values, "external_id"))
        name = _text(col(values, "name"))
        type_raw = _text(col(values, "type"))
        lat = lon = radius = cost = None
        try:
            cost = _num(col(values, "cost"))
            if cost is not None and cost < 0:
                errors.append(f"Стоимость {col(values, 'cost')} — отрицательная")
                cost = None
        except ValueError:
            errors.append(f"Стоимость «{col(values, 'cost')}» — не число (тыс. руб.)")
        try:
            lat = _num(col(values, "lat"))
        except ValueError:
            errors.append(f"Широта «{col(values, 'lat')}» — не число")
        try:
            lon = _num(col(values, "lon"))
        except ValueError:
            errors.append(f"Долгота «{col(values, 'lon')}» — не число")
        try:
            r = _num(col(values, "radius_m"))
            if r is not None:
                if not r.is_integer():
                    errors.append(f"Радиус «{col(values, 'radius_m')}» должен быть целым числом метров")
                elif not 1 <= r <= MAX_RADIUS_M:
                    errors.append(f"Радиус {int(r)} м вне диапазона 1–{MAX_RADIUS_M}")
                else:
                    radius = int(r)
        except ValueError:
            errors.append(f"Радиус «{col(values, 'radius_m')}» — не число")

        if not name:
            errors.append("Не заполнено название")
        type_row = None
        if not type_raw:
            errors.append("Не заполнен тип")
        else:
            type_row = type_index.get(type_raw.lower())
            if not type_row:
                errors.append(f"Неизвестный тип «{type_raw}»")
                unknown_types[type_raw] += 1

        cadastral = _text(col(values, "cadastral_number"))
        if cadastral and not CADASTRAL_RE.match(cadastral):
            warnings.append(f"Кадастровый номер «{cadastral}» не похож на формат 77:01:0001001:1234")

        geometry = None
        geom_raw = col(values, "geometry")
        if geom_raw not in (None, ""):
            try:
                geometry = parse_geometry(geom_raw)
            except GeometryError as e:
                errors.append(f"Геометрия: {e}")
            coord_errors = any("Широта" in e or "Долгота" in e for e in errors)
            if geometry and (lat is None or lon is None) and not coord_errors:
                lat, lon = label_point(geometry)

        address = _text(col(values, "address"))
        if lat is None or lon is None:
            if not any("Широта" in e or "Долгота" in e for e in errors):
                if address:
                    errors.append("Нет координат (геокодирование по адресу не включено)")
                else:
                    errors.append("Не заполнены координаты")
        else:
            lat_ok, lon_ok = -90 <= lat <= 90, -180 <= lon <= 180
            if not lat_ok or not lon_ok:
                msg = []
                if not lat_ok:
                    msg.append(f"широта {lat} вне диапазона −90…90")
                if not lon_ok:
                    msg.append(f"долгота {lon} вне диапазона −180…180")
                hint = " — похоже, широта и долгота перепутаны" if (-90 <= lon <= 90 and -180 <= lat <= 180) else ""
                errors.append("Координаты: " + ", ".join(msg) + hint)

        if ext:
            ext_counter[ext] += 1
            if ext_counter[ext] > 1:
                errors.append(f"ID «{ext}» повторяется в файле")

        attributes = {}
        for i, h in attr_cols:
            v = values[i]
            if v is not None:
                attributes[h] = _attr_value(v)

        rows.append(
            {
                "row": rownum,
                "values": values,
                "errors": errors,
                "warnings": warnings,
                "data": {
                    "external_id": ext,
                    "contract_number": _text(col(values, "contract_number")),
                    "cadastral_number": cadastral,
                    "cost": cost,
                    "geometry": geometry,
                    "type_id": type_row["id"] if type_row else None,
                    "type_name": type_row["name"] if type_row else type_raw,
                    "name": name,
                    "lat": lat,
                    "lon": lon,
                    "address": address,
                    "radius_m": radius,
                    "description": _text(col(values, "description")),
                    "attributes": attributes,
                },
            }
        )

    # Повтор ID: ошибка и у первого вхождения тоже, иначе неясно, какую строку взяли.
    dup = {k for k, n in ext_counter.items() if n > 1}
    for r in rows:
        ext = r["data"]["external_id"]
        if ext in dup and not any("повторяется" in e for e in r["errors"]):
            r["errors"].append(f"ID «{ext}» повторяется в файле")

    # Подозрение на перепутанные координаты: строка далеко от остальных, а после перестановки — рядом.
    good = [(r["data"]["lat"], r["data"]["lon"]) for r in rows if not r["errors"]]
    if len(good) >= 5:
        med = (statistics.median(p[0] for p in good), statistics.median(p[1] for p in good))
        for r in rows:
            if r["errors"]:
                continue
            p = (r["data"]["lat"], r["data"]["lon"])
            swapped = (p[1], p[0])
            if abs(swapped[0]) <= 90 and _dist(p, med) > 5 and _dist(swapped, med) * 5 < _dist(p, med):
                r["warnings"].append("Похоже, широта и долгота перепутаны")

    counts = Counter()
    for r in rows:
        d = r["data"]
        if r["errors"]:
            r["action"] = "skip"
        else:
            ext = d["external_id"]
            hit = existing.get(ext) if ext else None
            if mode == "add":
                if hit:
                    r["errors"].append(f"Объект с ID «{ext}» уже есть в базе — используйте режим «Обновить / добавить»")
                    r["action"] = "skip"
                else:
                    r["action"] = "create"
            elif mode == "upsert":
                if hit:
                    r["action"] = "update"
                    r["object_id"] = hit[0]
                else:
                    r["action"] = "create"
            else:  # replace
                if hit and hit[1] != source:
                    r["errors"].append(f"ID «{ext}» уже занят объектом из источника «{hit[1] or '—'}»")
                    r["action"] = "skip"
                else:
                    r["action"] = "create"
        counts[r["action"]] += 1
        if r["warnings"]:
            counts["warnings"] += 1

    to_delete = 0
    if mode == "replace":
        to_delete = db.execute("SELECT COUNT(*) FROM map_object WHERE source = ?", (source,)).fetchone()[0]

    return {
        "rows": rows,
        "has_geometry": "geometry" in by_field,
        "counts": {
            "total": len(rows),
            "create": counts["create"],
            "update": counts["update"],
            "delete": to_delete,
            "skip": counts["skip"],
            "warnings": counts["warnings"],
        },
        "unknown_types": [{"name": k, "rows": v} for k, v in unknown_types.most_common()],
    }


def preview_payload(result: dict, limit: int = 300) -> dict:
    rows = result["rows"]

    def brief(r):
        d = r["data"]
        return {
            "row": r["row"],
            "action": r["action"],
            "errors": r["errors"],
            "warnings": r["warnings"],
            "external_id": d["external_id"],
            "contract_number": d["contract_number"],
            "cadastral_number": d["cadastral_number"],
            "cost": d["cost"],
            "polygon": bool(d["geometry"]),
            "type_name": d["type_name"],
            "name": d["name"],
            "lat": d["lat"],
            "lon": d["lon"],
            "radius_m": d["radius_m"],
            "address": d["address"],
        }

    problem_rows = [r for r in rows if r["errors"] or r["warnings"]]
    ok_points = [[r["data"]["lon"], r["data"]["lat"], r["data"]["type_id"]] for r in rows if r["action"] != "skip"]
    step = max(1, len(ok_points) // 3000)
    return {
        "counts": result["counts"],
        "unknown_types": result["unknown_types"],
        "rows": [brief(r) for r in rows[:limit]],
        "problems": [brief(r) for r in problem_rows[:1000]],
        "problems_total": len(problem_rows),
        "points": ok_points[::step],
    }


def _object_snapshot(row) -> str:
    return json.dumps(dict(row), ensure_ascii=False)


def commit(db, batch: dict, result: dict, user) -> dict:
    """Записывает проверенные строки одной транзакцией; при сбое база не меняется."""
    ts = now()
    source = batch["source"]
    import_id = batch["id"]
    added = updated = deleted = 0
    with tx(db):
        old_by_ext = {}  # внешний ID → id удаляемого объекта, чтобы перенести комментарии на новый
        created_by_ext = {}
        if batch["mode"] == "replace":
            for old in db.execute("SELECT * FROM map_object WHERE source = ?", (source,)).fetchall():
                if old["external_id"]:
                    old_by_ext[old["external_id"]] = old["id"]
                db.execute(
                    "INSERT INTO import_change (import_id, object_id, action, before) VALUES (?,?,?,?)",
                    (import_id, old["id"], "deleted", _object_snapshot(old)),
                )
                deleted += 1
            db.execute("DELETE FROM map_object WHERE source = ?", (source,))
        for r in result["rows"]:
            if r["action"] == "skip":
                continue
            d = r["data"]
            st = search_text(d["name"], d["address"], d["external_id"], d["contract_number"], d["cadastral_number"])
            geom = geometry_dumps(d["geometry"])
            attrs = json.dumps(d["attributes"], ensure_ascii=False)
            if r["action"] == "update":
                before = db.execute("SELECT * FROM map_object WHERE id = ?", (r["object_id"],)).fetchone()
                db.execute(
                    "UPDATE map_object SET contract_number=?, cadastral_number=?, type_id=?, name=?, address=?, lat=?,"
                    " lon=?, radius_m=?, description=?, attributes=?, source=?, import_id=?, search_text=?, updated_at=?,"
                    " cost=?, geometry = CASE WHEN ? THEN ? ELSE geometry END WHERE id=?",
                    (d["contract_number"], d["cadastral_number"], d["type_id"], d["name"], d["address"], d["lat"],
                     d["lon"], d["radius_m"], d["description"], attrs, source, import_id, st, ts, d["cost"],
                     int(result["has_geometry"]), geom, r["object_id"]),
                )
                db.execute(
                    "INSERT INTO import_change (import_id, object_id, action, before) VALUES (?,?,?,?)",
                    (import_id, r["object_id"], "updated", _object_snapshot(before)),
                )
                updated += 1
            else:
                cur = db.execute(
                    "INSERT INTO map_object (external_id, contract_number, cadastral_number, type_id, name, address, lat,"
                    " lon, radius_m, description, attributes, source, import_id, search_text, created_at, updated_at, cost,"
                    " geometry) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (d["external_id"], d["contract_number"], d["cadastral_number"], d["type_id"], d["name"],
                     d["address"], d["lat"], d["lon"], d["radius_m"], d["description"], attrs, source, import_id, st,
                     ts, ts, d["cost"], geom),
                )
                db.execute(
                    "INSERT INTO import_change (import_id, object_id, action) VALUES (?,?,?)",
                    (import_id, cur.lastrowid, "created"),
                )
                if d["external_id"]:
                    created_by_ext[d["external_id"]] = cur.lastrowid
                added += 1
        for ext, new_id in created_by_ext.items():
            if ext in old_by_ext:
                db.execute("UPDATE object_comment SET object_id = ? WHERE object_id = ?", (new_id, old_by_ext[ext]))
        errors = result["counts"]["skip"]
        db.execute(
            "UPDATE import_batch SET status='committed', added=?, updated=?, deleted=?, errors=?, committed_at=? WHERE id=?",
            (added, updated, deleted, errors, ts, import_id),
        )
        audit(db, user, "import", "import_batch", import_id,
              {"file": batch["file_name"], "mode": batch["mode"], "source": source,
               "added": added, "updated": updated, "deleted": deleted, "errors": errors})
    DataVersion.bump()
    return {"added": added, "updated": updated, "deleted": deleted, "errors": errors}


def rollback(db, batch: dict, user) -> dict:
    restored = removed = 0
    with tx(db):
        changes = db.execute(
            "SELECT * FROM import_change WHERE import_id = ? ORDER BY id DESC", (batch["id"],)
        ).fetchall()
        # Объекты, удалённые этим импортом (режим «Заменить»): комментарии возвращаются к ним по внешнему ID.
        restored_by_ext = {}
        for c in changes:
            if c["action"] == "deleted":
                before = json.loads(c["before"])
                if before.get("external_id"):
                    restored_by_ext[before["external_id"]] = before["id"]
        for c in changes:
            if c["action"] == "created":
                row = db.execute("SELECT external_id FROM map_object WHERE id = ?", (c["object_id"],)).fetchone()
                ext = row["external_id"] if row else None
                if ext in restored_by_ext:
                    db.execute("UPDATE object_comment SET object_id = ? WHERE object_id = ?",
                               (restored_by_ext[ext], c["object_id"]))
                else:
                    db.execute("DELETE FROM object_comment WHERE object_id = ?", (c["object_id"],))
                db.execute("DELETE FROM map_object WHERE id = ?", (c["object_id"],))
                removed += 1
            else:
                before = json.loads(c["before"])
                if before.get("import_id") is not None and not db.execute(
                    "SELECT 1 FROM import_batch WHERE id = ?", (before["import_id"],)
                ).fetchone():
                    before["import_id"] = None
                cols = list(before.keys())
                db.execute(
                    f"INSERT OR REPLACE INTO map_object ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                    [before[k] for k in cols],
                )
                restored += 1
        db.execute("UPDATE import_batch SET status='rolled_back', rolled_back_at=? WHERE id=?", (now(), batch["id"]))
        audit(db, user, "rollback", "import_batch", batch["id"],
              {"file": batch["file_name"], "removed": removed, "restored": restored})
    DataVersion.bump()
    return {"removed": removed, "restored": restored}


def stored_path(name: str) -> Path:
    return IMPORT_DIR / name
