import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("profile_layout", Path(__file__).resolve().parent.parent / "host/profile-layout.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


class ProfileLayoutTests(unittest.TestCase):
    def fixture(self, root):
        (root / "Default").mkdir()
        (root / "Default/Cookies").write_bytes(b"private-cookie-database\x00\xff")
        (root / "Default/Cookies").chmod(0o600)
        (root / "Local State").write_text("private local state")
        (root / ".hidden").write_text("hidden data")
        (root / "SingletonLock").symlink_to("absent-old-host-123")
        (root / "lost+found").mkdir()
        return (root / "Default/Cookies").stat().st_ino

    def verify(self, root, inode):
        self.assertEqual((root / "user-data/Default/Cookies").read_bytes(), b"private-cookie-database\x00\xff")
        self.assertEqual((root / "user-data/Default/Cookies").stat().st_ino, inode)
        self.assertEqual((root / "user-data/Default/Cookies").stat().st_mode & 0o777, 0o600)
        self.assertEqual((root / "user-data/.hidden").read_text(), "hidden data")
        self.assertEqual(os.readlink(root / "user-data/SingletonLock"), "absent-old-host-123")
        self.assertTrue((root / "lost+found").is_dir())
        self.assertEqual(json.loads((root / ".agentbrowse-layout.json").read_text()), {"version": 2})
        self.assertFalse((root / "Default").exists())

    def test_relocation_resumes_after_every_durable_step_without_copying_or_dropping_files(self):
        # Inject failure at each directory-sync boundary, including after the
        # final rename but before the completion marker. One Python process.
        reached_end = False
        for interrupt_at in range(1, 30):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                inode = self.fixture(root)
                count = 0
                original = layout.sync_directory
                def interrupt(path):
                    nonlocal count
                    original(path)
                    count += 1
                    if count == interrupt_at:
                        raise RuntimeError("injected interruption")
                try:
                    with patch.object(layout, "sync_directory", side_effect=interrupt):
                        layout.prepare_profile(root)
                    reached_end = True
                except RuntimeError as error:
                    self.assertEqual(str(error), "injected interruption")
                layout.prepare_profile(root)
                self.verify(root, inode)
                layout.prepare_profile(root)
                self.verify(root, inode)
                if reached_end:
                    break
        self.assertTrue(reached_end)

    def test_new_profile_leaves_user_data_replaceable_by_kernel(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layout.prepare_profile(root)
            (root / "user-data").rename(root / ".user-data-old")
            (root / ".user-data-new").mkdir()
            (root / ".user-data-new").rename(root / "user-data")
            layout.prepare_profile(root)

    def test_collision_never_overwrites_either_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Cookies").write_text("original")
            (root / ".agentbrowse-user-data").mkdir()
            (root / ".agentbrowse-user-data/Cookies").write_text("conflict")
            layout.write_marker(root, {"version": 1, "entries": ["Cookies"]})
            with self.assertRaisesRegex(RuntimeError, "overwrite"):
                layout.prepare_profile(root)
            self.assertEqual((root / "Cookies").read_text(), "original")
            self.assertEqual((root / ".agentbrowse-user-data/Cookies").read_text(), "conflict")

    def test_missing_native_profile_is_not_replaced_with_an_empty_one(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layout.write_marker(root, {"version": 2})
            with self.assertRaisesRegex(RuntimeError, "missing"):
                layout.prepare_profile(root)
            self.assertFalse((root / "user-data").exists())

    def test_supervisor_uses_graceful_main_process_shutdown(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "chromium.conf"
            path.write_text("[program:chromium]\ncommand=/usr/local/bin/chromium-launcher\nstopsignal=KILL\nstopasgroup=true\nstopwaitsecs=1\nautorestart=true\n")
            layout.configure_shutdown(path)
            text = path.read_text()
            self.assertIn("stopsignal = TERM", text)
            self.assertIn("stopasgroup = false", text)
            self.assertIn("stopwaitsecs = 30", text)
            self.assertIn("autorestart = unexpected", text)
            self.assertIn("exitcodes = 0", text)
            self.assertNotIn("user = root", text)


if __name__ == "__main__":
    unittest.main()
