import json
import os
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "host/profile-backup.py"
BACKUP = runpy.run_path(str(SOURCE))


class FakeHypeman:
    def __init__(self, root, backend, volumes=None, instances=None):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.backend = backend
        self.volumes = list(volumes or [])
        self.instances = list(instances or [])
        self.next_id = 1
        self.fail_after_create_once = False

    def api(self):
        return {
            "owned": lambda root: self._owned(root),
            "request": self.request,
            "write_private": self.write_private,
        }

    def _owned(self, root):
        if root != self.root:
            raise RuntimeError("wrong synthetic root")

    @staticmethod
    def write_private(path, data):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = path.with_name(path.name + ".new")
        with temporary.open("x") as stream:
            stream.write(data)
        os.chmod(temporary, 0o600)
        temporary.replace(path)

    def request(self, root, method, path, body=None):
        self._owned(root)
        if method == "GET" and path == "/volumes":
            return [
                json.loads(
                    (
                        self.root / "data/volumes" / volume["id"] / "metadata.json"
                    ).read_text()
                )
                for volume in self.volumes
            ]
        if method == "GET" and path == "/instances":
            return list(self.instances)
        if method == "POST" and path == "/volumes":
            identity = "restored-%d" % self.next_id
            self.next_id += 1
            volume = {
                "id": identity,
                "name": body["name"],
                "size_gb": body["size_gb"],
                "tags": body["tags"],
            }
            directory = self.root / "data/volumes" / identity
            directory.mkdir(parents=True)
            metadata = {**volume, "attachments": []}
            (directory / "metadata.json").write_text(json.dumps(metadata))
            (directory / "data.raw").write_bytes(b"")
            self.volumes.append(volume)
            if self.fail_after_create_once:
                self.fail_after_create_once = False
                raise RuntimeError("synthetic lost create response")
            return volume
        if method == "DELETE" and path.startswith("/volumes/"):
            identity = path.rsplit("/", 1)[1]
            self.volumes = [volume for volume in self.volumes if volume["id"] != identity]
            shutil.rmtree(self.root / "data/volumes" / identity)
            return None
        raise RuntimeError("unexpected synthetic API request: %s %s" % (method, path))


def source_volume(root, backend="test", profile="research", attached=False):
    identity = "source-1"
    tags = {
        "dev.agentbrowse.managed": "true",
        "dev.agentbrowse.backend": backend,
        "dev.agentbrowse.role": "browser-profile",
        "dev.agentbrowse.profile": profile,
        "dev.agentbrowse.profile.schema": "1",
    }
    volume = {
        "id": identity,
        "name": "agentbrowse-profile-" + profile,
        "size_gb": 1,
        "tags": tags,
    }
    directory = root / "data/volumes" / identity
    directory.mkdir(parents=True)
    (directory / "metadata.json").write_text(
        json.dumps({**volume, "attachments": []}, sort_keys=True)
    )
    # Sparse holes and nonzero ext4-like payload exercise logical versus allocated size.
    with (directory / "data.raw").open("wb") as stream:
        stream.write(b"synthetic-profile\0" * 4096)
        stream.seek(4 * 1024 * 1024 - 1)
        stream.write(b"\0")
    instances = (
        [{"name": "browser", "volumes": [{"volume_id": identity}]}] if attached else []
    )
    return volume, instances


class ProfileBackupTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agentbrowse-profile-backup-")
        self.base = Path(self.temporary.name)
        checker = self.base / "e2fsck"
        checker.write_text("#!/bin/sh\nexit 0\n")
        checker.chmod(0o755)
        self.old_checker = os.environ.get("AGENTBROWSE_E2FSCK")
        os.environ["AGENTBROWSE_E2FSCK"] = str(checker)

    def tearDown(self):
        if self.old_checker is None:
            os.environ.pop("AGENTBROWSE_E2FSCK", None)
        else:
            os.environ["AGENTBROWSE_E2FSCK"] = self.old_checker
        self.temporary.cleanup()

    def test_measure_reports_reconciliation_and_both_unit_systems(self):
        root = self.base / "source"
        volume, instances = source_volume(root, attached=True)
        hypeman = FakeHypeman(root, "test", [volume], instances)
        result = BACKUP["measure"](hypeman.api(), root, "test", True)

        self.assertEqual(result["profileCount"], 1)
        self.assertEqual(result["reconciliationFindings"][0]["code"], "attached")
        self.assertEqual(result["totals"]["bytes"]["reserved"], 1024 ** 3)
        self.assertEqual(result["totals"]["decimal"]["reserved"]["gigabytes"], 1.073741824)
        self.assertEqual(result["totals"]["binary"]["reserved"]["gibibytes"], 1)
        self.assertEqual(
            result["compressionEstimate"]["method"], "stratified-zstd-level-3-v1"
        )
        self.assertGreater(result["totals"]["bytes"]["expectedCompressed"], 0)

    def test_plaintext_backup_is_manifest_last_resumable_and_restores_a_new_volume_id(self):
        source_root = self.base / "source"
        volume, instances = source_volume(source_root, backend="source")
        source = FakeHypeman(source_root, "source", [volume], instances)
        backup_set = self.base / "sets/one"

        created = BACKUP["backup"](
            source.api(), source_root, "source", backup_set, [], True, False
        )
        self.assertTrue(created["complete"])
        self.assertRegex(created["setDigest"], r"^[0-9a-f]{64}$")
        manifest = BACKUP["inspect_set"](backup_set, None, True)
        self.assertEqual(manifest["format"], "agentbrowse-hypeman-profile-backup")
        self.assertEqual(manifest["encryption"]["method"], "none-explicit")
        entry = manifest["profiles"][0]
        self.assertNotIn("tags", entry["source"]["volume"])
        self.assertNotIn("attachments", json.dumps(manifest))

        # An incomplete set has no publication manifest. Its complete per-profile
        # entry is reused without replacing the archive.
        archive = backup_set / entry["archive"]["path"]
        archive_before = archive.stat().st_mtime_ns
        (backup_set / "manifest.json").unlink()
        resumed = BACKUP["backup"](
            source.api(), source_root, "source", backup_set, [], True, False
        )
        self.assertFalse(resumed["resumed"])
        self.assertEqual(archive.stat().st_mtime_ns, archive_before)

        destination_root = self.base / "destination"
        destination = FakeHypeman(destination_root, "destination")
        restored = BACKUP["restore"](
            destination.api(), destination_root, "destination", backup_set, None, True, False,
            BACKUP["inspect_set"](backup_set, None, True)["setDigest"]
        )
        self.assertEqual(restored["complete"], ["research"])
        self.assertNotEqual(destination.volumes[0]["id"], volume["id"])
        metadata = json.loads(
            (
                destination_root
                / "data/volumes"
                / destination.volumes[0]["id"]
                / "metadata.json"
            ).read_text()
        )
        self.assertEqual(metadata["name"], "agentbrowse-profile-research")
        self.assertEqual(metadata["tags"]["dev.agentbrowse.backend"], "destination")
        self.assertNotIn("dev.agentbrowse.slot", metadata["tags"])
        restored_raw = destination_root / "data/volumes" / destination.volumes[0]["id"] / "data.raw"
        source_raw = source_root / "data/volumes" / volume["id"] / "data.raw"
        self.assertEqual(BACKUP["sha256_file"](restored_raw), BACKUP["sha256_file"](source_raw))

        receipt = next(destination_root.glob("profile-restores/*/research.json"))
        interrupted = json.loads(receipt.read_text())
        interrupted["complete"] = False
        receipt.write_text(json.dumps(interrupted))
        repeated = BACKUP["restore"](
            destination.api(), destination_root, "destination", backup_set, None, True, False,
            BACKUP["inspect_set"](backup_set, None, True)["setDigest"]
        )
        self.assertEqual(repeated["complete"], ["research"])
        self.assertEqual(len(destination.volumes), 1)
        self.assertTrue(json.loads(receipt.read_text())["complete"])

    def test_encryption_is_default_and_plaintext_needs_explicit_acknowledgement(self):
        root = self.base / "source"
        volume, instances = source_volume(root)
        hypeman = FakeHypeman(root, "test", [volume], instances)
        with self.assertRaisesRegex(RuntimeError, "authenticated encryption is the default"):
            BACKUP["backup"](
                hypeman.api(), root, "test", self.base / "set", [], False, False
            )

        old_age = os.environ.get("AGENTBROWSE_AGE")
        os.environ["AGENTBROWSE_AGE"] = str(self.base / "missing-age")
        try:
            with self.assertRaisesRegex(RuntimeError, "age is required"):
                BACKUP["backup"](
                    hypeman.api(),
                    root,
                    "test",
                    self.base / "encrypted-set",
                    ["age1example"],
                    False,
                    True,
                )
        finally:
            if old_age is None:
                os.environ.pop("AGENTBROWSE_AGE", None)
            else:
                os.environ["AGENTBROWSE_AGE"] = old_age

    def test_encrypted_manifest_authenticates_policy_and_downgrade_fails_closed(self):
        age = self.base / "age"
        age.write_text(
            "#!/usr/bin/env python3\n"
            "import pathlib, sys\n"
            "if '-d' in sys.argv:\n"
            " identity=pathlib.Path(sys.argv[sys.argv.index('-i')+1]).read_text()\n"
            " if identity != 'synthetic identity': sys.exit(2)\n"
            " data=pathlib.Path(sys.argv[-1]).read_bytes()[8:]\n"
            " sys.stdout.buffer.write(bytes(value ^ 0xa5 for value in data))\n"
            "else:\n"
            " data=sys.stdin.buffer.read()\n"
            " sys.stdout.buffer.write(b'FAKE-AGE'+bytes(value ^ 0xa5 for value in data))\n"
        )
        age.chmod(0o755)
        identity = self.base / "identity.txt"
        identity.write_text("synthetic identity")
        old_age = os.environ.get("AGENTBROWSE_AGE")
        os.environ["AGENTBROWSE_AGE"] = str(age)
        try:
            root = self.base / "source"
            volume, instances = source_volume(root)
            hypeman = FakeHypeman(root, "test", [volume], instances)
            backup_set = self.base / "encrypted"
            BACKUP["backup"](
                hypeman.api(), root, "test", backup_set, ["age1synthetic"], False, False
            )
            self.assertTrue((backup_set / "manifest.json.age").is_file())
            self.assertFalse((backup_set / "manifest.json").exists())
            listed = BACKUP["list_sets"](backup_set.parent)
            self.assertTrue(listed["sets"][0]["locked"])
            with self.assertRaisesRegex(RuntimeError, "requires an age --identity"):
                BACKUP["inspect_set"](backup_set)
            wrong_identity = self.base / "wrong-identity.txt"
            wrong_identity.write_text("wrong")
            with self.assertRaisesRegex(RuntimeError, "authentication failed"):
                BACKUP["inspect_set"](backup_set, str(wrong_identity), False)
            manifest = BACKUP["inspect_set"](backup_set, str(identity), False)
            self.assertEqual(manifest["encryption"]["method"], "age-x25519")
            self.assertEqual(
                BACKUP["inspect_set"](
                    backup_set, str(identity), False, manifest["setDigest"]
                )["setDigest"],
                manifest["setDigest"],
            )
            with self.assertRaisesRegex(RuntimeError, "externally retained"):
                BACKUP["inspect_set"](
                    backup_set, str(identity), False, "0" * 64
                )
            outer = (backup_set / "backup-state.json").read_text()
            outer += "\n".join(
                path.read_text() for path in backup_set.glob("profiles/*/resume.json")
            )
            self.assertNotIn("research", outer)
            self.assertNotIn("source-1", outer)
            self.assertEqual(list(backup_set.rglob("*.partial")), [])
            self.assertEqual(list(backup_set.rglob("*.zstd")), [])
            encrypted_archive = next(backup_set.glob("profiles/*/data.raw.zst.age"))
            self.assertNotIn(b"synthetic-profile", encrypted_archive.read_bytes())
            destination_root = self.base / "destination"
            destination = FakeHypeman(destination_root, "destination")
            dry_run = BACKUP["restore"](
                destination.api(), destination_root, "destination", backup_set,
                str(identity), False, True, manifest["setDigest"]
            )
            self.assertTrue(dry_run["dryRun"])
            self.assertEqual(destination.volumes, [])
            self.assertFalse((destination_root / "profile-restores").exists())
            with self.assertRaisesRegex(RuntimeError, "different source or encryption options"):
                BACKUP["backup"](
                    hypeman.api(), root, "test", backup_set,
                    ["age1different"], False, False
                )

            (backup_set / "manifest.json.age").unlink()
            manifest.pop("setDigest")
            (backup_set / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(RuntimeError, "explicit --allow-unencrypted"):
                BACKUP["inspect_set"](backup_set)
        finally:
            if old_age is None:
                os.environ.pop("AGENTBROWSE_AGE", None)
            else:
                os.environ["AGENTBROWSE_AGE"] = old_age

    def test_inspect_rejects_a_changed_archive(self):
        root = self.base / "source"
        volume, instances = source_volume(root)
        hypeman = FakeHypeman(root, "test", [volume], instances)
        backup_set = self.base / "set"
        BACKUP["backup"](hypeman.api(), root, "test", backup_set, [], True, False)
        archive = next(backup_set.glob("profiles/*/data.raw.zst"))
        with archive.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(RuntimeError, "integrity"):
            BACKUP["inspect_set"](backup_set, None, True)

    def test_plaintext_requires_explicit_restore_acknowledgement(self):
        root = self.base / "source"
        volume, instances = source_volume(root)
        hypeman = FakeHypeman(root, "test", [volume], instances)
        backup_set = self.base / "set"
        BACKUP["backup"](hypeman.api(), root, "test", backup_set, [], True, False)
        with self.assertRaisesRegex(RuntimeError, "explicit --allow-unencrypted"):
            BACKUP["inspect_set"](backup_set)

    def test_backup_refuses_foreign_nonempty_destination(self):
        root = self.base / "source"
        volume, instances = source_volume(root)
        hypeman = FakeHypeman(root, "test", [volume], instances)
        destination = self.base / "foreign"
        destination.mkdir()
        (destination / "unrelated.txt").write_text("keep")
        with self.assertRaisesRegex(RuntimeError, "nonempty backup destination"):
            BACKUP["backup"](
                hypeman.api(), root, "test", destination, [], True, False
            )
        self.assertEqual((destination / "unrelated.txt").read_text(), "keep")

        shutil.rmtree(destination)
        destination.mkdir()
        state = destination / "backup-state.json"
        state.write_text(json.dumps({"forged": True}))
        os.chmod(state, 0o600)
        with self.assertRaisesRegex(RuntimeError, "unexpected fields"):
            BACKUP["backup"](
                hypeman.api(), root, "test", destination, [], True, False
            )

    def test_streaming_encryption_failure_removes_recoverable_partial_bytes(self):
        age = self.base / "age-cat"
        age.write_text("#!/bin/sh\ncat\n")
        age.chmod(0o755)
        zstd = self.base / "zstd-fail"
        zstd.write_text("#!/bin/sh\ncat\nexit 1\n")
        zstd.chmod(0o755)
        old_age = os.environ.get("AGENTBROWSE_AGE")
        old_zstd = os.environ.get("AGENTBROWSE_ZSTD")
        os.environ["AGENTBROWSE_AGE"] = str(age)
        os.environ["AGENTBROWSE_ZSTD"] = str(zstd)
        try:
            root = self.base / "source"
            volume, instances = source_volume(root)
            source = FakeHypeman(root, "test", [volume], instances)
            backup_set = self.base / "set"
            with self.assertRaisesRegex(RuntimeError, "compression or encryption failed"):
                BACKUP["backup"](
                    source.api(), root, "test", backup_set,
                    ["age1synthetic"], False, False
                )
            self.assertEqual(list(backup_set.rglob("*.partial")), [])
            self.assertEqual(list(backup_set.rglob("*.zstd")), [])
            self.assertFalse((backup_set / "manifest.json.age").exists())
        finally:
            if old_age is None:
                os.environ.pop("AGENTBROWSE_AGE", None)
            else:
                os.environ["AGENTBROWSE_AGE"] = old_age
            if old_zstd is None:
                os.environ.pop("AGENTBROWSE_ZSTD", None)
            else:
                os.environ["AGENTBROWSE_ZSTD"] = old_zstd

    def test_intermediate_symlink_and_decompression_overrun_are_rejected(self):
        root = self.base / "source"
        volume, instances = source_volume(root)
        hypeman = FakeHypeman(root, "test", [volume], instances)
        backup_set = self.base / "real/set"
        BACKUP["backup"](hypeman.api(), root, "test", backup_set, [], True, False)
        link = self.base / "linked"
        link.symlink_to(self.base / "real", target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "symlinked path component"):
            BACKUP["inspect_set"](link / "set", None, True)

        manifest_path = backup_set / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["profiles"][0]["archive"]["rawBytes"] = 1
        manifest_path.write_text(json.dumps(manifest))
        destination_root = self.base / "destination"
        destination = FakeHypeman(destination_root, "destination")
        with self.assertRaisesRegex(RuntimeError, "exceeds its recorded size"):
            BACKUP["restore"](
                destination.api(), destination_root, "destination", backup_set,
                None, True, False, BACKUP["inspect_set"](backup_set, None, True)["setDigest"]
            )
        staging = destination_root / "data/volumes/restored-1/restore.raw"
        self.assertFalse(staging.exists())
        inspected = BACKUP["inspect_set"](backup_set, None, True)
        released = BACKUP["restore"](
            destination.api(), destination_root, "destination", backup_set,
            None, True, False, inspected["setDigest"], True
        )
        self.assertEqual(released["released"], ["research"])
        self.assertEqual(destination.volumes, [])

    def test_restore_preserves_large_zero_runs_as_sparse_extents(self):
        source_root = self.base / "source"
        volume, instances = source_volume(source_root)
        source_raw = source_root / "data/volumes/source-1/data.raw"
        with source_raw.open("r+b") as stream:
            stream.truncate(64 * 1024 * 1024)
        source = FakeHypeman(source_root, "test", [volume], instances)
        backup_set = self.base / "set"
        BACKUP["backup"](source.api(), source_root, "test", backup_set, [], True, False)
        destination_root = self.base / "destination"
        destination = FakeHypeman(destination_root, "destination")
        BACKUP["restore"](
            destination.api(), destination_root, "destination", backup_set, None, True, False,
            BACKUP["inspect_set"](backup_set, None, True)["setDigest"]
        )
        raw = destination_root / "data/volumes/restored-1/data.raw"
        self.assertLess(raw.stat().st_blocks * 512, raw.stat().st_size)

    def test_sparse_writer_holes_zero_extents_smaller_than_one_mebibyte(self):
        class RecordingStream:
            def __init__(self):
                self.operations = []

            def seek(self, count, direction):
                self.operations.append(("seek", count, direction))

            def write(self, value):
                self.operations.append(("write", bytes(value)))

        stream = RecordingStream()
        BACKUP["write_sparse_extent"](stream, b"\0" * 4096)
        BACKUP["write_sparse_extent"](stream, b"x" * 4096)
        self.assertEqual(stream.operations[0], ("seek", 4096, os.SEEK_CUR))
        self.assertEqual(stream.operations[1], ("write", b"x" * 4096))

    def test_restore_reconciles_create_that_committed_before_response_loss(self):
        source_root = self.base / "source"
        volume, instances = source_volume(source_root)
        source = FakeHypeman(source_root, "test", [volume], instances)
        backup_set = self.base / "set"
        BACKUP["backup"](source.api(), source_root, "test", backup_set, [], True, False)
        manifest = BACKUP["inspect_set"](backup_set, None, True)
        destination_root = self.base / "destination"
        destination = FakeHypeman(destination_root, "destination")
        destination.fail_after_create_once = True
        with self.assertRaisesRegex(RuntimeError, "lost create response"):
            BACKUP["restore"](
                destination.api(), destination_root, "destination", backup_set,
                None, True, False, manifest["setDigest"]
            )
        self.assertEqual(len(destination.volumes), 1)
        restored = BACKUP["restore"](
            destination.api(), destination_root, "destination", backup_set,
            None, True, False, manifest["setDigest"]
        )
        self.assertEqual(restored["complete"], ["research"])
        self.assertEqual(len(destination.volumes), 1)

    def test_dry_run_decrypts_and_verifies_payload_without_creating_a_volume(self):
        source_root = self.base / "source"
        volume, instances = source_volume(source_root)
        source = FakeHypeman(source_root, "test", [volume], instances)
        backup_set = self.base / "set"
        BACKUP["backup"](source.api(), source_root, "test", backup_set, [], True, False)
        manifest_path = backup_set / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        archive = backup_set / manifest["profiles"][0]["archive"]["path"]
        archive.write_bytes(b"not-zstd")
        digest, size = BACKUP["sha256_file"](archive)
        manifest["profiles"][0]["archive"]["sha256"] = digest
        manifest["profiles"][0]["archive"]["bytes"] = size
        manifest_path.write_text(json.dumps(manifest))
        expected = BACKUP["manifest_digest"](manifest)
        destination_root = self.base / "destination"
        destination = FakeHypeman(destination_root, "destination")
        with self.assertRaisesRegex(RuntimeError, "decryption or decompression"):
            BACKUP["restore"](
                destination.api(), destination_root, "destination", backup_set,
                None, True, True, expected
            )
        self.assertEqual(destination.volumes, [])
        self.assertFalse((destination_root / "profile-restores").exists())


if __name__ == "__main__":
    unittest.main()
