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
        self.backend = backend
        self.volumes = list(volumes or [])
        self.instances = list(instances or [])
        self.next_id = 1

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
            return volume
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
        manifest = BACKUP["inspect_set"](backup_set)
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
            destination.api(), destination_root, "destination", backup_set, None, False
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
            destination.api(), destination_root, "destination", backup_set, None, False
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
                    False,
                )
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
            BACKUP["inspect_set"](backup_set)


if __name__ == "__main__":
    unittest.main()
