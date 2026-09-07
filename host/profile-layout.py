"""Prepare a Hypeman profile volume before Kernel starts any browser processes.

The volume owns /home/kernel so Kernel can rename user-data during /configure.
The old layout put Chromium's files directly in the volume root. Relocation is
an offline series of same-filesystem renames, journaled before the first move.
"""
import json
import os
from pathlib import Path


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_marker(root, value):
    temporary = root / ".agentbrowse-layout.tmp"
    with temporary.open("w") as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(root / ".agentbrowse-layout.json")
    sync_directory(root)


def prepare_profile(root):
    marker = root / ".agentbrowse-layout.json"
    staging = root / ".agentbrowse-user-data"
    destination = root / "user-data"
    if marker.is_symlink() or staging.is_symlink() or destination.is_symlink():
        raise RuntimeError("profile layout paths must not be symlinks")
    if marker.exists():
        state = json.loads(marker.read_text())
        if state == {"version": 2}:
            if not destination.is_dir():
                raise RuntimeError("profile user-data is missing; inspect the retained volume")
            return
        if state.get("version") != 1 or not isinstance(state.get("entries"), list):
            raise RuntimeError("unknown profile relocation journal")
    else:
        if destination.exists() or staging.exists():
            raise RuntimeError("ambiguous profile layout; inspect the retained volume")
        entries = sorted(p.name for p in root.iterdir() if p.name != "lost+found")
        if any(name.startswith(".agentbrowse-") for name in entries):
            raise RuntimeError("unrecognized profile layout metadata")
        state = {"version": 1, "entries": entries}
        write_marker(root, state)
    entries = state["entries"]
    if any(not isinstance(n, str) or n in ("", ".", "..", "user-data", "lost+found")
           or "/" in n or n.startswith(".agentbrowse-") for n in entries):
        raise RuntimeError("invalid profile relocation journal")
    if destination.exists():
        # The final rename completed, but writing the completion marker did not.
        if staging.exists() or any(os.path.lexists(root / n) for n in entries):
            raise RuntimeError("conflicting profile relocation state")
        if not destination.is_dir() or any(not os.path.lexists(destination / n) for n in entries):
            raise RuntimeError("incomplete profile relocation")
    else:
        staging.mkdir(mode=0o700, exist_ok=True)
        sync_directory(root)
        for name in entries:
            source, target = root / name, staging / name
            if os.path.lexists(source):
                if os.path.lexists(target):
                    raise RuntimeError("profile relocation would overwrite " + name)
                source.rename(target)
                sync_directory(staging)
                sync_directory(root)
            elif not os.path.lexists(target):
                raise RuntimeError("profile relocation lost track of " + name)
        staging.rename(destination)
        sync_directory(root)
    write_marker(root, {"version": 2})


def configure_shutdown(path):
    # Kernel's image defaults to KILL/1s. Keep its supervisor lifecycle, but
    # allow a bounded termination window for native configuration restarts.
    # Durable close uses CDP Browser.close, then checks supervisor exit status.
    import configparser
    config = configparser.ConfigParser(interpolation=None)
    if not config.read(path) or "program:chromium" not in config:
        raise RuntimeError("Kernel Chromium supervisor configuration is missing")
    program = config["program:chromium"]
    program["stopsignal"] = "TERM"
    program["stopasgroup"] = "false"
    program["stopwaitsecs"] = "30"
    # Browser.close must finish flushing without supervisor immediately starting
    # a new writer. Crashes still restart; explicit launches start an exited one.
    program["autorestart"] = "unexpected"
    program["exitcodes"] = "0"
    with path.open("w") as output:
        config.write(output)


if __name__ == "__main__":
    prepare_profile(Path("/home/kernel"))
    configure_shutdown(Path("/etc/supervisor/conf.d/services/chromium.conf"))
