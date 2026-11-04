"""Rollback eligibility checks. Call under the same write transaction as the mutation."""
import json


class RollbackConflict(ValueError):
    def __init__(self, code, message, conflicts=()):
        self.detail = dict(code=code, message=message, count=len(conflicts), conflicts=list(conflicts[:50]))
        super().__init__(message)


def footprint(db, import_id):
    return [list(r) for r in db.execute(
        "SELECT DISTINCT c.object_id, COALESCE(r.revision, 0), o.id IS NOT NULL "
        "FROM import_change c LEFT JOIN object_revision r ON r.object_id=c.object_id "
        "LEFT JOIN map_object o ON o.id=c.object_id WHERE c.import_id=? ORDER BY c.object_id", (import_id,)
    )]


def capture(db, import_id):
    return json.dumps(dict(version=1, objects=footprint(db, import_id)), separators=(",", ":"))


def baseline(batch):
    try:
        value = json.loads(batch["rollback_baseline"])
        rows = value["objects"]
        if value["version"] != 1 or not isinstance(rows, list) or not rows:
            return None
        if any(not isinstance(r, list) or len(r) != 3 or
               any(type(v) is not int for v in r) or r[1] < 0 or r[2] not in (0, 1) for r in rows):
            return None
        if len({r[0] for r in rows}) != len(rows):
            return None
        return rows
    except (KeyError, TypeError, ValueError):
        return None


def check(db, import_id):
    row = db.execute("SELECT * FROM import_batch WHERE id=?", (import_id,)).fetchone()
    if row is None or row["status"] != "committed":
        raise RollbackConflict("rollback_not_committed", "Откатить можно только выполненный импорт")
    batch = dict(row)
    latest = db.execute("SELECT MAX(id) FROM import_batch WHERE status='committed'").fetchone()[0]
    if latest != import_id:
        raise RollbackConflict("rollback_not_latest", "Откатывать импорты можно только по порядку, начиная с последнего")
    expected = baseline(batch)
    actual = footprint(db, import_id)
    if expected is None or {r[0] for r in expected} != {r[0] for r in actual}:
        raise RollbackConflict("rollback_baseline_missing", "У импорта нет достоверной контрольной версии; автоматический откат недоступен")
    expected = {r[0]: r[1:] for r in expected}
    conflicts = [dict(object_id=oid, reason="changed_after_import")
                 for oid, revision, present in actual if expected[oid] != [revision, present]]
    changes = db.execute("SELECT * FROM import_change WHERE import_id=? ORDER BY id DESC", (import_id,)).fetchall()
    created = {c["object_id"] for c in changes if c["action"] == "created"}
    for c in changes:
        if c["action"] == "created":
            continue
        before = json.loads(c["before"])
        if before.get("external_id") is not None:
            owner = db.execute("SELECT id FROM map_object WHERE external_id=?", (before["external_id"],)).fetchone()
            if owner and owner[0] != c["object_id"] and owner[0] not in created:
                conflicts.append(dict(object_id=c["object_id"], reason="external_id_in_use"))
    if conflicts:
        raise RollbackConflict("rollback_conflict", "Откат отменён: объекты или комментарии изменились после импорта либо возник конфликт идентификаторов", conflicts)
    return batch, changes
