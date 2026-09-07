import importlib.machinery
import importlib.util
from pathlib import Path
import tempfile
import os
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


host = load("host", ROOT / "host/agentbrowse-hypeman")
migration = load("migration", ROOT / "host/migrate-profiles.py")


class HostSafetyTests(unittest.TestCase):
    def test_caddy_cleanup_requires_exact_owned_orphan(self):
        root = Path("/home/operator/.local/share/ab-hypeman")
        command = "/opt/homebrew/bin/caddy run --config " + str(root / "data/caddy/config.json")
        uid = os.geteuid()
        processes = "\n".join([
            f"101 1 {uid} {command}",
            f"102 50 {uid} {command}",
            f"103 1 {uid + 1} {command}",
            f"104 1 {uid} {command}.foreign",
        ])
        self.assertEqual(host.orphan_caddy_pids(root, processes), [101])

    def test_state_symlinks_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "OWNED").write_text(host.MARKER)
            (root / "token").symlink_to(root / "unrelated")
            with self.assertRaisesRegex(RuntimeError, "unsafe Hypeman state"):
                host.owned(root)

    def test_profile_names_do_not_prove_ownership(self):
        with self.assertRaises(RuntimeError):
            migration.profile_name("agentbrowse-profile-testing", {})

    def test_mismatched_profile_tags_are_refused(self):
        tags = {"dev.agentbrowse.profile": "another", "dev.agentbrowse.managed": "true",
                "dev.agentbrowse.role": "browser-profile", "dev.agentbrowse.profile.schema": "1"}
        with self.assertRaises(RuntimeError):
            migration.profile_name("agentbrowse-profile-testing", tags)

    def test_foreign_container_blocks_all_stops(self):
        owned = {"configuration": {"id": "ours", "labels": {"dev.agentbrowse.managed": "true", "dev.agentbrowse.role": "kernel-browser"}}, "status": "running"}
        foreign = {"configuration": {"id": "foreign", "labels": {}}, "status": "running"}
        with patch.object(migration, "MAC", True), patch.object(migration, "json_command", return_value=[owned, foreign]), patch.object(migration, "run") as run:
            with self.assertRaises(RuntimeError):
                migration.stop_sources()
            run.assert_not_called()

    def test_sparse_verification_detects_changed_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            image = Path(d) / "disk"
            with image.open("wb") as f:
                f.write(b"original")
                f.seek(1024 * 1024)
                f.write(b"tail")
            before = migration.sparse_hash(image)
            with image.open("r+b") as f:
                f.write(b"modified")
            self.assertNotEqual(before, migration.sparse_hash(image))


if __name__ == "__main__":
    unittest.main()
