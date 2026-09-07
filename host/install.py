#!/usr/bin/env python3
"""Install AgentBrowse's pinned Hypeman host runtime, preserving existing volumes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import runpy
import shutil
import subprocess
import sys

SOURCE = Path(__file__).resolve().parent
MAC = sys.platform == "darwin"
BROWSER_IMAGE = "docker.io/onkernel/chromium-headful@sha256:da9ee68cb9d2de0b3c26885ff3bdcf04c944254a36eb127219028ac017ff56f3"


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def configure_linux_forwarding(path=Path("/etc/sysctl.d/70-agentbrowse-hypeman.conf")):
    marker = "# Managed by AgentBrowse Hypeman host installer\n"
    if path.is_symlink() or (path.exists() and (
        not path.is_file() or path.stat().st_uid != os.geteuid() or not path.read_text().startswith(marker)
    )):
        raise RuntimeError("refusing foreign Hypeman forwarding configuration")
    content = marker + "net.ipv4.ip_forward = 1\n"
    if not path.exists() or path.read_text() != content:
        temporary = path.with_name(path.name + ".new")
        with temporary.open("x") as output:
            output.write(content)
        temporary.chmod(0o644)
        temporary.replace(path)
    run("sysctl", "--load", path)
    if run("sysctl", "-n", "net.ipv4.ip_forward", capture_output=True, text=True).stdout.strip() != "1":
        raise RuntimeError("Hypeman requires IPv4 forwarding")


def install():
    if MAC:
        if platform.machine() != "arm64":
            raise RuntimeError("the Mac host requires Apple silicon")
        if not shutil.which("brew"):
            raise RuntimeError("install Homebrew through Funk first")
        for package in ("caddy", "e2fsprogs"):
            probe = subprocess.run(["brew", "list", "--versions", package], capture_output=True)
            if probe.returncode:
                run("brew", "install", package)
        root = Path.home() / ".local/share/ab-hypeman"
        destination = root / "host"
    else:
        if os.geteuid() != 0 or platform.machine() != "x86_64":
            raise RuntimeError("the Linux host installer requires root on x86_64")
        if not Path("/dev/kvm").exists():
            raise RuntimeError("enable hardware virtualization: /dev/kvm is missing")
        run("apt-get", "update")
        run("apt-get", "install", "-y", "python3", "curl", "e2fsprogs", "erofs-utils", "iptables", "nftables")
        root = Path("/var/lib/agentbrowse-hypeman")
        destination = Path("/usr/local/lib/agentbrowse")

    api = runpy.run_path(str(SOURCE / "agentbrowse-hypeman"))
    if root.exists():
        api["owned"](root)
    else:
        root.mkdir(mode=0o700, parents=True)
        api["write_private"](root / "OWNED", api["MARKER"] + "\n")
    if not MAC:
        configure_linux_forwarding()
        unit = Path("/etc/systemd/system/agentbrowse-hypeman.service")
        if unit.exists():
            expected_start = "ExecStart=/usr/bin/python3 %s --root %s serve" % (destination / "agentbrowse-hypeman", root)
            if unit.is_symlink() or unit.stat().st_uid != 0 or expected_start not in unit.read_text().splitlines():
                raise RuntimeError("refusing foreign Hypeman systemd service")
            # Recover a service that failed at boot because a prerequisite was
            # absent before auditing its instances and replacing helper bytes.
            run(sys.executable, destination / "agentbrowse-hypeman", "enable")
    receipt = root / "host-install.json"
    pending = root / "pending-host-install.json"
    files = ("agentbrowse-hypeman", "hypeman-relay.py", "install.py", "migrate-profiles.py")
    digests = {name: hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() for name in files}
    expected = {"version": 1, "files": digests, "destination": str(destination)}
    if not pending.exists() and receipt.exists() and json.loads(receipt.read_text()) == expected and all(
        (destination / name).is_file() and hashlib.sha256((destination / name).read_bytes()).hexdigest() == digest
        for name, digest in digests.items()
    ):
        run(sys.executable, destination / "agentbrowse-hypeman", "enable")
        print(json.dumps({"installed": True, "changed": False}))
        return

    running = json.loads(pending.read_text()) if pending.exists() else []
    try:
        instances = api["request"](root, "GET", "/instances", timeout=3)
    except (OSError, RuntimeError):
        # A first installation or explicitly disabled service has no API.
        instances = None
    if instances is not None:
        if any((i.get("tags") or {}).get("dev.agentbrowse.managed") != "true" for i in instances):
            raise RuntimeError("foreign Hypeman instances prevent host service replacement")
        running = sorted(set(running + [i["id"] for i in instances if i["state"] not in ("Stopped", "Shutdown")]))
        api["write_private"](pending, json.dumps(running) + "\n")
        run(sys.executable, SOURCE / "agentbrowse-hypeman", "disable")
    elif (root / "config.yaml").exists():
        # Refuse to replace bytes around a service that is loaded but unhealthy.
        if MAC:
            for label in (api["LABEL"], *api["LEGACY_LABELS"]):
                probe = subprocess.run(["launchctl", "print", "gui/%d/%s" % (os.getuid(), label)], capture_output=True)
                if probe.returncode == 0:
                    raise RuntimeError("loaded Hypeman service is unhealthy; inspect its logs before reinstalling")
        elif subprocess.run(["systemctl", "is-active", "--quiet", "agentbrowse-hypeman"]).returncode == 0:
            raise RuntimeError("active Hypeman service is unhealthy")

    if destination.exists() and destination.is_symlink():
        raise RuntimeError("refusing symlinked host installation directory")
    destination.mkdir(parents=True, exist_ok=True, mode=0o755)
    for name in files:
        target = destination / name
        if target.is_symlink():
            raise RuntimeError("refusing symlinked host command")
        temporary = destination / ("." + name + ".new")
        if temporary.exists() or temporary.is_symlink():
            raise RuntimeError("unexpected host installation staging file")
        with temporary.open("xb") as output:
            output.write((SOURCE / name).read_bytes())
        temporary.chmod(0o755)
        temporary.replace(target)
    if not MAC:
        target = Path("/usr/local/bin/agentbrowse-hypeman")
        if target.exists() and not target.is_symlink():
            if "agentbrowse-hypeman-v1" not in target.read_text():
                raise RuntimeError("refusing foreign host command")
            target.unlink()
        if target.is_symlink() and target.resolve() != destination / "agentbrowse-hypeman":
            raise RuntimeError("refusing foreign host command link")
        if not target.exists():
            target.symlink_to(destination / "agentbrowse-hypeman")
    helper = destination / "agentbrowse-hypeman"
    run(sys.executable, helper, "setup")
    run(sys.executable, helper, "enable")
    run(sys.executable, helper, "pull", BROWSER_IMAGE)
    current = {i["id"]: i["state"] for i in api["request"](root, "GET", "/instances")}
    for instance_id in running:
        if instance_id not in current:
            raise RuntimeError("pending restoration instance is missing: " + instance_id)
        if current[instance_id] not in ("Running", "Initializing"):
            api["request"](root, "POST", "/instances/" + instance_id + "/start", {})
    if not MAC:
        api["network_sync"](root)
    api["write_private"](receipt, json.dumps(expected, indent=2) + "\n")
    pending.unlink(missing_ok=True)
    print(json.dumps({"installed": True, "changed": True, "restoredInstances": len(running)}))


if __name__ == "__main__":
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        install()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print("AgentBrowse host install: " + str(error), file=sys.stderr)
        sys.exit(1)
