import importlib.machinery
import importlib.util
from pathlib import Path
import tempfile
import json
import io
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
installer = load("installer", ROOT / "host/install.py")
relay = load("relay", ROOT / "host/hypeman-relay.py")


class HostSafetyTests(unittest.TestCase):
    def test_kernel_api_relay_tracks_exact_guest_incarnation_and_slot(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "connection.json").write_text(json.dumps({"baseUrl": "http://127.0.0.1:4973"}))
            (root / "token").write_text("synthetic")
            instance = {"id": "original", "state": "Running", "network": {"ip": "192.168.64.42"}, "tags": {
                "dev.agentbrowse.managed": "true", "dev.agentbrowse.role": "kernel-browser",
                "dev.agentbrowse.hypeman.spec": "1", "dev.agentbrowse.slot": "7",
                "dev.agentbrowse.port-offset": "2000"}}
            with patch.object(relay, "Forward") as forward, patch.object(relay.urllib.request, "urlopen",
                    side_effect=lambda *_args, **_kwargs: io.BytesIO(json.dumps([instance]).encode())):
                service = relay.Relay(root)
                service.sync()
                self.assertIn(("192.168.64.42", 10001, "original"), [s for s, _f in service.forwards.values()])
                forward.assert_any_call(30087, "192.168.64.42", 10001, False)
                old = service.forwards[(30087, False)][1]
                instance["id"] = "replacement"
                service.sync()
                old.close.assert_called()
                self.assertEqual(service.forwards[(30087, False)][0][2], "replacement")
                service.close()

    def test_linux_forwarding_is_persistent_and_refuses_foreign_files(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "forwarding.conf"
            with patch.object(installer, "run", return_value=SimpleNamespace(stdout="1\n")):
                installer.configure_linux_forwarding(path)
                first_inode = path.stat().st_ino
                installer.configure_linux_forwarding(path)
                self.assertEqual(first_inode, path.stat().st_ino)
                self.assertIn("net.ipv4.ip_forward = 1", path.read_text())
                path.write_text("# another owner\nnet.ipv4.ip_forward = 0\n")
                with self.assertRaisesRegex(RuntimeError, "foreign"):
                    installer.configure_linux_forwarding(path)
                self.assertIn("ip_forward = 0", path.read_text())

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
