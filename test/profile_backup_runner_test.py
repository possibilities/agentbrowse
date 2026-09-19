import importlib.machinery
import importlib.util
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load_runner():
    path = ROOT / "scripts/run-profile-backup-helper"
    loader = importlib.machinery.SourceFileLoader("profile_backup_runner", str(path))
    spec = importlib.util.spec_from_loader("profile_backup_runner", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


RUNNER = load_runner()


class ProfileBackupRunnerTest(unittest.TestCase):
    def test_streams_only_the_profile_backup_helper_without_installing_or_restarting(self):
        observed = {}

        def run(command, **options):
            observed["command"] = command
            observed["source"] = options["stdin"].read()
            observed["check"] = options["check"]
            return subprocess.CompletedProcess(command, 0)

        RUNNER.invoke(
            "artbird",
            "hypeman-artbird",
            ["create", "--destination", "/private/backup set", "--dry-run"],
            run,
        )

        self.assertEqual(observed["source"], (ROOT / "host/profile-backup.py").read_bytes())
        self.assertTrue(observed["check"])
        command = observed["command"]
        self.assertEqual(command[:6], [
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "artbird"
        ])
        self.assertIn("--destination '/private/backup set'", command[6])
        self.assertIn("--backend hypeman-artbird", command[6])
        self.assertNotIn("install-host", " ".join(command))
        self.assertNotIn("systemctl", " ".join(command))
        self.assertNotIn("apt", " ".join(command))

    def test_refuses_runner_ownership_overrides_and_unsafe_names(self):
        with self.assertRaisesRegex(ValueError, "fixed"):
            RUNNER.remote_command("artbird", "artbird", ["measure", "--root", "/tmp"])
        with self.assertRaisesRegex(ValueError, "plain SSH"):
            RUNNER.remote_command("artbird; reboot", "artbird", ["measure"])
        with self.assertRaisesRegex(ValueError, "backend"):
            RUNNER.remote_command("artbird", "Artbird", ["measure"])


if __name__ == "__main__":
    unittest.main()
