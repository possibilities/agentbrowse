import importlib.machinery
import importlib.util
from pathlib import Path
import tempfile
import json
import io
import os
import sys
import threading
import unittest
import urllib.error
from unittest.mock import Mock, patch

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

    def test_macos_relay_idle_does_not_repeat_initial_hydration(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            service = Mock()
            service.sync = Mock()
            service.close = Mock()
            control = relay.RelayControl(root, service)
            try:
                service.sync()
                for _ in range(4):
                    control.serve_once(timeout=0.01)
                service.sync.assert_called_once_with()
            finally:
                control.close()

    def test_macos_relay_refuses_to_replace_an_active_control_socket(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            first = relay.RelayControl(root, Mock())
            try:
                with self.assertRaisesRegex(RuntimeError, "already active"):
                    relay.RelayControl(root, Mock())
            finally:
                first.close()

    def test_macos_relay_control_acknowledges_lifecycle_sync(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            service = Mock()
            service.sync = Mock()
            service.close = Mock()
            control = relay.RelayControl(root, service)
            worker = threading.Thread(target=control.serve_once, kwargs={"timeout": 1})
            worker.start()
            try:
                relay.request_sync(root)
                worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
                service.sync.assert_called_once_with()
            finally:
                control.close()

    def test_local_network_sync_command_reaches_the_running_relay(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            service = Mock()
            service.sync = Mock()
            service.close = Mock()
            control = relay.RelayControl(root, service)
            worker = threading.Thread(target=control.serve_once, kwargs={"timeout": 1})
            worker.start()
            try:
                with patch.object(host, "MAC", True), patch.object(
                    sys, "argv", ["agentbrowse-hypeman", "--root", d, "network-sync"]
                ), patch("sys.stdout", new_callable=io.StringIO) as output:
                    host.main()
                worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(json.loads(output.getvalue()), {"synchronized": True})
                service.sync.assert_called_once_with()
            finally:
                control.close()

    def test_macos_relay_control_reports_failure_and_clears_forwards(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            service = Mock()
            service.sync.side_effect = RuntimeError("bad forwarding state")
            service.close = Mock()
            control = relay.RelayControl(root, service)
            worker = threading.Thread(target=control.serve_once, kwargs={"timeout": 1})
            worker.start()
            try:
                with self.assertRaisesRegex(RuntimeError, "bad forwarding state"):
                    relay.request_sync(root)
                worker.join(timeout=2)
                self.assertFalse(worker.is_alive())
                service.close.assert_called_once_with()
            finally:
                control.close()

    def test_macos_supervisor_hydrates_once_then_waits_for_control(self):
        class Child:
            def __init__(self):
                self.polls = 0

            def poll(self):
                self.polls += 1
                return None if self.polls < 6 else 0

        class Stopped:
            @staticmethod
            def is_set():
                return False

        service = Mock()
        control = Mock()
        module = Mock()
        module.RelayControl.return_value = control
        host.run_macos_relay(Path("/private/root"), service, Child(), Stopped(), module)
        service.sync.assert_called_once_with()
        self.assertGreaterEqual(control.serve_once.call_count, 1)
        control.close.assert_called_once_with()

    def test_macos_supervisor_does_not_retry_reachable_http_failures(self):
        service = Mock()
        service.sync.side_effect = urllib.error.HTTPError(
            "http://localhost/instances", 401, "unauthorized", {}, io.BytesIO(b"unauthorized")
        )
        child = Mock()
        child.poll.return_value = None
        stopped = Mock()
        stopped.is_set.return_value = False

        with self.assertRaises(urllib.error.HTTPError):
            host.run_macos_relay(Path("/private/root"), service, child, stopped, Mock())

        service.sync.assert_called_once_with()
        service.close.assert_called_once_with()

    def test_macos_readiness_probes_api_once_while_waiting_for_control_socket(self):
        relay_module = Mock()
        relay_module.request_sync.side_effect = [RuntimeError("not listening yet"), None]
        with patch.object(host, "request") as request, patch.object(host.time, "sleep"):
            host.wait_ready(Path("/private/root"), relay_module, timeout=1)

        request.assert_called_once_with(Path("/private/root"), "GET", "/instances", timeout=3)
        self.assertEqual(relay_module.request_sync.call_count, 2)

    def test_readiness_does_not_retry_reachable_api_failures(self):
        with patch.object(host, "request", side_effect=host.HypemanHTTPError("Hypeman HTTP 401")) as request:
            with self.assertRaisesRegex(host.HypemanHTTPError, "401"):
                host.wait_ready(Path("/private/root"), timeout=1)
        request.assert_called_once_with(Path("/private/root"), "GET", "/instances", timeout=3)

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

    def test_host_install_refreshes_forwarding_after_restoring_stopped_instances(self):
        calls = []

        def request(_root, method, path, body=None):
            calls.append((method, path, body))
            if method == "GET":
                return [{"id": "running", "state": "Running"}, {"id": "stopped", "state": "Stopped"}]

        with patch.object(installer, "run") as run:
            restored = installer.restore_instances(
                {"request": request}, Path("/owned/root"), ["running", "stopped"], Path("/owned/helper")
            )
        self.assertEqual(restored, 1)
        self.assertIn(("POST", "/instances/stopped/start", {}), calls)
        run.assert_called_once_with(sys.executable, Path("/owned/helper"), "network-sync")

    def test_host_identity_is_created_once_and_refuses_unsafe_replacement(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            api = {"write_private": host.write_private}
            first = installer.ensure_host_identity(api, root)
            second = installer.ensure_host_identity(api, root)
            self.assertEqual(first, second)
            self.assertRegex(first, installer.HOST_IDENTITY)
            self.assertEqual((root / "host-identity").stat().st_mode & 0o777, 0o600)

            (root / "host-identity").unlink()
            (root / "host-identity").symlink_to(root / "elsewhere")
            with self.assertRaisesRegex(RuntimeError, "unsafe"):
                installer.ensure_host_identity(api, root)

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

            (root / "token").unlink()
            (root / "host-identity").symlink_to(root / "unrelated")
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
