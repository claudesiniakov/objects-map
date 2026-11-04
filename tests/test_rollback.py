"""Synthetic databases only; never start the application's production lifespan."""
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import tracemalloc
import unittest

# config creates directories and loads a key at import time, so isolate it first.
_data = tempfile.TemporaryDirectory(prefix="objmap-tests-")
os.environ["OBJMAP_DATA_DIR"] = _data.name
os.environ["OBJMAP_SECRET"] = "synthetic-test-secret"

from backend.app import db, importer, main
from fastapi import HTTPException

USER = dict(id=1, login="test", full_name="Test", role="admin")


def connection(path=":memory:"):
    con = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=5)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    return con


def seed(con):
    con.executescript(db.SCHEMA)
    db.migrate(con)
    con.execute("INSERT INTO object_type(id,code,name) VALUES(1,'test','Test')")
    con.execute("INSERT INTO object_type(id,code,name) VALUES(2,'other','Other')")
    con.execute("INSERT INTO user(id,login,password_hash,role,created_at) VALUES(1,'test','unused','admin','test')")


def object_row(con, ext="A", name="Before", oid=None):
    return con.execute(
        "INSERT INTO map_object(id,external_id,type_id,name,lat,lon,source,created_at,updated_at)"
        " VALUES(?,?,1,?,1,1,'test','test','test')", (oid, ext, name)
    ).lastrowid


def prepare(con, mode="add", ext="A", name="Imported"):
    bid = con.execute(
        "INSERT INTO import_batch(file_name,stored_file,source,mode,status,created_at)"
        " VALUES('synthetic.csv','unused','test',?,'checked','test')", (mode,)
    ).lastrowid
    b = dict(con.execute("SELECT * FROM import_batch WHERE id=?", (bid,)).fetchone())
    table = dict(headers=["ID", "Type", "Name", "Lat", "Lon"], rows=[(2, [ext, "test", name, 1, 1])])
    mapping = dict(ID="external_id", Type="type", Name="name", Lat="lat", Lon="lon")
    result = importer.validate(con, table, mapping, mode, "test")
    return b, result


def batch(con, mode="add", ext="A", name="Imported"):
    b, result = prepare(con, mode, ext, name)
    importer.commit(con, b, result, USER)
    return b["id"]


def state(con):
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    return {t: [tuple(r) for r in con.execute(f'SELECT * FROM "{t}" ORDER BY rowid')] for t in tables}


class RollbackTests(unittest.TestCase):
    def setUp(self):
        self.con = connection()
        self.addCleanup(self.con.close)
        seed(self.con)

    def rollback(self, bid):
        return main.import_rollback(bid, USER, self.con)

    def reject(self, bid, code="rollback_conflict"):
        before, version = state(self.con), db.DataVersion.value
        with self.assertRaises(HTTPException) as caught:
            self.rollback(bid)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail["code"], code)
        self.assertEqual(state(self.con), before)
        self.assertEqual(db.DataVersion.value, version)
        return caught.exception.detail

    def test_normal_add_and_history(self):
        bid = batch(self.con)
        self.assertTrue(main.import_history(USER, self.con)[0]["can_rollback"])
        self.assertEqual(self.rollback(bid), dict(removed=1, restored=0))
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM map_object").fetchone()[0], 0)
        self.assertEqual(self.con.execute("SELECT action FROM audit_log ORDER BY id DESC").fetchone()[0], "rollback")
        self.assertFalse(main.import_history(USER, self.con)[0]["can_rollback"])
        self.reject(bid, "rollback_not_committed")

    def test_normal_upsert_preserves_existing_comments(self):
        oid = object_row(self.con)
        main.add_comment(oid, main.CommentIn(text="Before import"), USER, self.con)
        before = dict(self.con.execute("SELECT * FROM map_object").fetchone())
        bid = batch(self.con, "upsert")
        self.assertEqual(self.rollback(bid), dict(removed=0, restored=1))
        self.assertEqual(dict(self.con.execute("SELECT * FROM map_object").fetchone()), before)
        self.assertEqual(self.con.execute("SELECT text FROM object_comment").fetchone()[0], "Before import")

    def test_manual_edit_blocks_entire_batch(self):
        object_row(self.con)
        bid = batch(self.con, "upsert")
        self.con.execute("UPDATE map_object SET name='Manual' WHERE id=1")
        detail = self.reject(bid)
        self.assertEqual(detail["conflicts"][0]["object_id"], 1)
        self.assertNotIn("Manual", json.dumps(detail))

    def test_same_value_and_change_then_revert_are_changes(self):
        for statements in [
            ["UPDATE map_object SET name=name WHERE id=1"],
            ["UPDATE map_object SET name='Manual' WHERE id=1", "UPDATE map_object SET name='Imported' WHERE id=1"],
        ]:
            with self.subTest(statements=statements):
                other = connection()
                seed(other)
                bid = batch(other)
                for sql in statements:
                    other.execute(sql)
                old, self.con = self.con, other
                try:
                    self.reject(bid)
                finally:
                    self.con = old
                    other.close()

    def test_delete_and_recreate_are_changes(self):
        for recreate in [False, True]:
            with self.subTest(recreate=recreate):
                bid = batch(self.con, ext=str(recreate))
                oid = self.con.execute("SELECT MAX(id) FROM map_object").fetchone()[0]
                self.con.execute("DELETE FROM map_object WHERE id=?", (oid,))
                if recreate:
                    object_row(self.con, str(recreate), "Imported", oid)
                self.reject(bid)

    def test_added_and_deleted_comment_block_rollback(self):
        oid = object_row(self.con)
        comment = main.add_comment(oid, main.CommentIn(text="Existing"), USER, self.con)
        bid = batch(self.con, "upsert")
        main.delete_comment(comment["id"], USER, self.con)
        self.reject(bid)
        bid = batch(self.con, "upsert")
        main.add_comment(oid, main.CommentIn(text="New secret text"), USER, self.con)
        detail = self.reject(bid)
        self.assertNotIn("New secret text", json.dumps(detail))

    def test_comment_move_marks_both_objects(self):
        a = object_row(self.con)
        b = object_row(self.con, "B")
        comment = main.add_comment(a, main.CommentIn(text="Existing"), USER, self.con)
        bid = batch(self.con, "upsert")
        self.con.execute("UPDATE object_comment SET object_id=? WHERE id=?", (b, comment["id"]))
        self.reject(bid)

    def test_unrelated_object_and_pin_do_not_block(self):
        object_row(self.con)
        other = object_row(self.con, "B")
        bid = batch(self.con, "upsert")
        self.con.execute("UPDATE map_object SET name='Other changed' WHERE id=?", (other,))
        self.con.execute("INSERT INTO user_pin(user_id,name,lat,lon,color,created_at,updated_at) VALUES(1,'Personal',1,1,'#123456','test','test')")
        self.assertEqual(self.rollback(bid)["restored"], 1)
        self.assertEqual(self.con.execute("SELECT name FROM map_object WHERE id=?", (other,)).fetchone()[0], "Other changed")

    def test_replace_restores_comments_without_id_aliasing(self):
        a = object_row(self.con)
        b = object_row(self.con, "B")
        ca = main.add_comment(a, main.CommentIn(text="Comment A"), USER, self.con)
        cb = main.add_comment(b, main.CommentIn(text="Comment B"), USER, self.con)
        before = [tuple(r) for r in self.con.execute("SELECT * FROM map_object ORDER BY id")]
        bid = batch(self.con, "replace")
        new_id = self.con.execute("SELECT id FROM map_object").fetchone()[0]
        self.assertNotIn(new_id, [a, b])
        self.assertEqual(self.con.execute("SELECT object_id FROM object_comment WHERE id=?", (ca["id"],)).fetchone()[0], new_id)
        self.assertEqual(self.con.execute("SELECT object_id FROM object_comment WHERE id=?", (cb["id"],)).fetchone()[0], b)
        self.assertEqual(self.rollback(bid), dict(removed=1, restored=2))
        self.assertEqual([tuple(r) for r in self.con.execute("SELECT * FROM map_object ORDER BY id")], before)
        self.assertEqual([r[0] for r in self.con.execute("SELECT object_id FROM object_comment ORDER BY id")], [a, b])

    def test_delete_only_replace_then_add_rollback_preserves_old_comments(self):
        oid = object_row(self.con)
        comment = main.add_comment(oid, main.CommentIn(text="Old retained comment"), USER, self.con)
        deleted = batch(self.con, "replace", name="")  # invalid input row, but valid source deletion
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM map_object").fetchone()[0], 0)
        added = batch(self.con, ext="D")
        self.rollback(added)
        self.assertEqual([r[0] for r in self.con.execute("SELECT text FROM object_comment WHERE id=?", (comment["id"],))], ["Old retained comment"])
        # Non-overlapping batch history still permits restoring the deleted A.
        self.rollback(deleted)
        self.assertEqual(self.con.execute("SELECT name FROM map_object WHERE id=?", (oid,)).fetchone()[0], "Before")

    def test_manual_create_cannot_take_over_retained_comment_id(self):
        oid = object_row(self.con)
        main.add_comment(oid, main.CommentIn(text="Old retained comment"), USER, self.con)
        bid = batch(self.con, "replace", name="")
        manual = main.create_object(main.ObjectIn(type_id=1, name="Independent", lat=1, lon=1), USER, self.con)
        self.assertNotEqual(manual["id"], oid)
        self.assertEqual(main.list_comments(manual["id"], USER, self.con), [])
        self.rollback(bid)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM map_object").fetchone()[0], 2)

    def test_legacy_retained_comment_ids_are_reserved(self):
        # A migration cannot invent revisions for comments retained before deployment.
        self.con.execute("INSERT INTO object_comment(object_id,author,text,created_at) VALUES(100,'Test','Legacy','test')")
        self.con.execute("DELETE FROM object_revision")
        bid = batch(self.con)
        oid = self.con.execute("SELECT id FROM map_object").fetchone()[0]
        self.assertGreater(oid, 100)
        self.rollback(bid)
        self.assertEqual(self.con.execute("SELECT text FROM object_comment").fetchone()[0], "Legacy")

    def test_deleted_id_reuse_blocks_replace_rollback(self):
        a = object_row(self.con)
        bid = batch(self.con, "replace", ext="B")
        object_row(self.con, "C", oid=a)
        self.reject(bid)

    def test_external_id_collision_does_not_delete_other_object(self):
        object_row(self.con)
        bid = batch(self.con, "replace", ext="B")
        other = object_row(self.con, "A")
        detail = self.reject(bid)
        self.assertTrue(any(c["reason"] == "external_id_in_use" for c in detail["conflicts"]))
        self.assertEqual(self.con.execute("SELECT external_id FROM map_object WHERE id=?", (other,)).fetchone()[0], "A")

    def test_later_rollback_does_not_make_old_footprint_current(self):
        object_row(self.con)
        first = batch(self.con, "upsert")
        second = batch(self.con, "upsert", name="Later")
        self.reject(first, "rollback_not_latest")
        self.rollback(second)
        self.reject(first)

    def test_legacy_batch_fails_closed(self):
        bid = batch(self.con)
        self.con.execute("UPDATE import_batch SET rollback_baseline=NULL WHERE id=?", (bid,))
        self.assertFalse(main.import_history(USER, self.con)[0]["can_rollback"])
        self.reject(bid, "rollback_baseline_missing")

    def test_failure_during_restore_is_atomic(self):
        object_row(self.con)
        bid = batch(self.con, "replace", ext="B")
        self.con.execute("CREATE TRIGGER fail_restore BEFORE INSERT ON map_object WHEN NEW.name='Before' BEGIN SELECT RAISE(ABORT,'injected'); END")
        before, version = state(self.con), db.DataVersion.value
        with self.assertRaises(sqlite3.IntegrityError):
            self.rollback(bid)
        self.assertEqual(state(self.con), before)
        self.assertEqual(db.DataVersion.value, version)

    def test_conflict_list_is_bounded_but_count_is_complete(self):
        # A replace touches all 75 old IDs even when they no longer exist.
        for i in range(75):
            object_row(self.con, str(i))
        bid = batch(self.con, "replace", ext="new")
        for i in range(1, 76):
            object_row(self.con, "manual-" + str(i), oid=i)
        detail = self.reject(bid)
        self.assertEqual(detail["count"], 75)
        self.assertLessEqual(len(detail["conflicts"]), 50)

    def test_migration_preserves_legacy_data_and_is_idempotent(self):
        con = connection()
        self.addCleanup(con.close)
        con.executescript(db.SCHEMA)
        con.execute("INSERT INTO object_type(id,code,name) VALUES(1,'test','Test')")
        oid = object_row(con)
        con.execute("INSERT INTO import_batch(id,file_name,stored_file,status,created_at) VALUES(1,'old','unused','committed','test')")
        before = tuple(con.execute("SELECT * FROM map_object").fetchone())
        db.migrate(con)
        db.migrate(con)
        self.assertEqual(tuple(con.execute("SELECT * FROM map_object").fetchone()), before)
        self.assertIsNone(con.execute("SELECT rollback_baseline FROM import_batch").fetchone()[0])
        con.execute("UPDATE map_object SET name='Changed' WHERE id=?", (oid,))
        self.assertEqual(con.execute("SELECT revision FROM object_revision WHERE object_id=?", (oid,)).fetchone()[0], 1)
        self.assertEqual(con.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(con.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_rollback_role_dependency(self):
        route = next(r for r in main.app.routes if getattr(r, "path", "") == "/api/import/{import_id}/rollback")
        dependency = next(d.call for d in route.dependant.dependencies if d.name == "user")
        for role in ("operator", "admin"):
            self.assertEqual(dependency(dict(USER, role=role))["role"], role)
        with self.assertRaises(HTTPException) as caught:
            dependency(dict(USER, role="viewer"))
        self.assertEqual(caught.exception.status_code, 403)

    def test_duplicate_commit_rejected_without_writes(self):
        bid = batch(self.con)
        b = dict(self.con.execute("SELECT * FROM import_batch WHERE id=?", (bid,)).fetchone())
        b["status"] = "checked"  # stale caller data
        before = state(self.con)
        with self.assertRaises(ValueError):
            importer.commit(self.con, b, dict(rows=[], counts={"skip": 0}), USER)
        self.assertEqual(state(self.con), before)

    def test_malformed_baseline_fails_closed(self):
        bid = batch(self.con)
        for value in ("not JSON", "null", "[]", '{"version":2,"objects":[[1,1,1]]}', '{"version":1,"objects":[]}'):
            with self.subTest(value=value):
                self.con.execute("UPDATE import_batch SET rollback_baseline=? WHERE id=?", (value, bid))
                self.reject(bid, "rollback_baseline_missing")

    def test_history_memory_does_not_scale_with_old_baselines(self):
        # History is a metadata list, not a download of all historical footprints.
        large = json.dumps(dict(version=1, objects=[[i, 3, 1] for i in range(10000)]))
        for i in range(20):
            self.con.execute("INSERT INTO import_batch(file_name,stored_file,status,created_at,rollback_baseline) VALUES('synthetic','unused','committed','test',?)", (large,))
        tracemalloc.start()
        try:
            history = main.import_history(USER, self.con)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(len(history), 20)
        self.assertTrue(history[0]["can_rollback"])
        self.assertTrue(all("rollback_baseline" not in r for r in history))
        self.assertLess(peak, 1_000_000, "metadata history loaded full historical footprints")


class GatedConnection(sqlite3.Connection):
    """Pause a real transaction after acquiring its lock, without replacing SQL behavior."""
    def execute(self, sql, parameters=()):
        is_begin = sql == "BEGIN IMMEDIATE"
        if (is_begin or sql.startswith("UPDATE import_batch SET status='checked'")) and getattr(self, "attempted", None):
            self.attempted.set()
        result = super().execute(sql, parameters)
        if is_begin and getattr(self, "locked", None):
            self.locked.set()
            if not self.release.wait(5):
                raise RuntimeError("transaction barrier timed out")
            self.locked = None
        return result


class ConcurrentRollbackTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="objmap-wal-")
        self.addCleanup(self.directory.cleanup)
        self.path = str(Path(self.directory.name) / "synthetic.sqlite")
        self.con = connection(self.path)
        self.addCleanup(self.con.close)
        seed(self.con)

    def race(self, first, second):
        """Second reaches BEGIN while first owns the write lock; then release first."""
        a = sqlite3.connect(self.path, factory=GatedConnection, isolation_level=None, check_same_thread=False, timeout=5)
        b = sqlite3.connect(self.path, factory=GatedConnection, isolation_level=None, check_same_thread=False, timeout=5)
        for con in (a, b):
            con.row_factory = sqlite3.Row
            con.execute("PRAGMA foreign_keys=ON")
        a.locked, a.release, b.attempted = threading.Event(), threading.Event(), threading.Event()
        locked = a.locked
        results = [None, None]

        def run(index, action, con):
            try:
                results[index] = action(con)
            except BaseException as e:
                results[index] = e

        threads = [threading.Thread(target=run, args=(0, first, a)), threading.Thread(target=run, args=(1, second, b))]
        try:
            threads[0].start()
            self.assertTrue(locked.wait(5), "first operation did not lock")
            threads[1].start()
            self.assertTrue(b.attempted.wait(5), "second operation did not reach lock")
        finally:
            a.release.set()
            for thread in threads:
                if thread.ident is not None:
                    thread.join(6)
            for con in (a, b):
                con.close()
        self.assertTrue(all(not t.is_alive() for t in threads))
        self.assertEqual(self.con.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        self.assertEqual(self.con.execute("PRAGMA foreign_key_check").fetchall(), [])
        return results

    def test_rollback_then_comment_cannot_create_orphan(self):
        bid = batch(self.con)
        results = self.race(
            lambda c: main.import_rollback(bid, USER, c),
            lambda c: main.add_comment(1, main.CommentIn(text="Concurrent"), USER, c),
        )
        self.assertEqual(results[0], dict(removed=1, restored=0))
        self.assertIsInstance(results[1], HTTPException)
        self.assertEqual(results[1].status_code, 404)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM object_comment").fetchone()[0], 0)

    def test_writer_then_rollback_rejects_changed_object(self):
        comment = {"id": 1}
        actions = [
            lambda c: main.update_object(1, main.ObjectIn(type_id=1, name="Manual", lat=1, lon=1), USER, c),
            lambda c: main.add_comment(1, main.CommentIn(text="New"), USER, c),
            lambda c: main.delete_comment(comment["id"], USER, c),
            lambda c: main.bulk_type(main.BulkIn(ids=[1], type_id=2), USER, c),
            lambda c: main.bulk_delete(main.BulkIn(ids=[1]), USER, c),
            lambda c: main.delete_object(1, USER, c),
        ]
        for action in actions:
            with self.subTest(action=actions.index(action)):
                for table in ("object_comment", "map_object", "import_change", "import_batch", "audit_log", "object_revision"):
                    self.con.execute(f"DELETE FROM {table}")
                object_row(self.con, oid=1)
                comment.update(main.add_comment(1, main.CommentIn(text="Existing"), USER, self.con))
                bid = batch(self.con, "upsert")
                first, second = self.race(action, lambda c: main.import_rollback(bid, USER, c))
                self.assertNotIsInstance(first, BaseException)
                self.assertIsInstance(second, HTTPException)
                self.assertEqual(second.status_code, 409)
                self.assertEqual(second.detail["code"], "rollback_conflict")

    def test_rollback_then_object_update_or_delete_rechecks_existence(self):
        for action in [
            lambda c, oid: main.update_object(oid, main.ObjectIn(type_id=1, name="Manual", lat=1, lon=1), USER, c),
            lambda c, oid: main.delete_object(oid, USER, c),
        ]:
            bid = batch(self.con)
            oid = self.con.execute("SELECT id FROM map_object").fetchone()[0]
            first, second = self.race(lambda c: main.import_rollback(bid, USER, c), lambda c: action(c, oid))
            self.assertNotIsInstance(first, BaseException)
            self.assertIsInstance(second, HTTPException)
            self.assertEqual(second.status_code, 404)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM audit_log WHERE action='update'").fetchone()[0], 0)

    def test_rollback_then_comment_delete_uses_restored_owner_in_audit(self):
        oid = object_row(self.con)
        comment = main.add_comment(oid, main.CommentIn(text="Existing"), USER, self.con)
        bid = batch(self.con, "replace")
        first, second = self.race(
            lambda c: main.import_rollback(bid, USER, c),
            lambda c: main.delete_comment(comment["id"], USER, c),
        )
        self.assertNotIsInstance(first, BaseException)
        self.assertEqual(second, dict(ok=True))
        details = self.con.execute("SELECT details FROM audit_log WHERE action='delete' AND entity='object_comment'").fetchone()[0]
        self.assertEqual(json.loads(details)["object_id"], oid)

    def test_two_rollbacks_serialize(self):
        bid = batch(self.con)
        first, second = self.race(lambda c: main.import_rollback(bid, USER, c), lambda c: main.import_rollback(bid, USER, c))
        self.assertEqual(first, dict(removed=1, restored=0))
        self.assertIsInstance(second, HTTPException)
        self.assertEqual(second.detail["code"], "rollback_not_committed")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM audit_log WHERE action='rollback'").fetchone()[0], 1)

    def test_new_commit_then_old_rollback_rechecks_latest(self):
        bid = batch(self.con)
        first, second = self.race(lambda c: batch(c, ext="B"), lambda c: main.import_rollback(bid, USER, c))
        self.assertIsInstance(first, int)
        self.assertIsInstance(second, HTTPException)
        self.assertEqual(second.detail["code"], "rollback_not_latest")

    def test_rollback_then_new_commit_does_not_update_removed_target(self):
        bid = batch(self.con)
        b, result = prepare(self.con, "upsert")
        first, second = self.race(
            lambda c: main.import_rollback(bid, USER, c),
            lambda c: importer.commit(c, b, result, USER),
        )
        self.assertEqual(first, dict(removed=1, restored=0))
        self.assertIsInstance(second, ValueError)
        self.assertEqual(second.detail["code"], "import_stale")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM map_object").fetchone()[0], 0)
        self.assertEqual(self.con.execute("SELECT status FROM import_batch WHERE id=?", (b["id"],)).fetchone()[0], "checked")

    def test_commit_then_preview_cannot_reset_committed_status(self):
        # Use a genuine synthetic file so preview runs its normal validation path.
        from backend.app.config import IMPORT_DIR
        path = IMPORT_DIR / "concurrent-preview.csv"
        path.write_text("ID,Type,Name,Lat,Lon\nA,test,Imported,1,1\n")
        b, result = prepare(self.con)
        self.con.execute("UPDATE import_batch SET stored_file=? WHERE id=?", (path.name, b["id"]))
        b["stored_file"] = path.name
        sheet = next(iter(importer.load_table(path.name)))
        body = main.PreviewIn(sheet=sheet, mapping=dict(ID="external_id", Type="type", Name="name", Lat="lat", Lon="lon"), mode="add", source="test")
        first, second = self.race(
            lambda c: importer.commit(c, b, result, USER),
            lambda c: main.import_preview(b["id"], body, USER, c),
        )
        self.assertNotIsInstance(first, BaseException)
        self.assertIsInstance(second, HTTPException)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(self.con.execute("SELECT status FROM import_batch WHERE id=?", (b["id"],)).fetchone()[0], "committed")


if __name__ == "__main__":
    unittest.main()
