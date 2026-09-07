#!/usr/bin/env python3
"""Explicit, resumable migration of owned Docker/Apple profiles into Hypeman.

Source data is retained. Each destination is recorded before copying, detached
while copying, and verified before its migration receipt becomes complete.
"""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import tempfile

MAC = sys.platform == "darwin"
ROOT = Path.home() / ".local/share/ab-hypeman" if MAC else Path("/var/lib/agentbrowse-hypeman")
API = runpy.run_path(str(Path(__file__).with_name("agentbrowse-hypeman")))


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def json_command(args):
    return json.loads(run(args, capture_output=True, text=True).stdout)


def profile_name(name, tags):
    profile = tags.get("dev.agentbrowse.profile", "")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", profile) or name != "agentbrowse-profile-" + profile:
        raise RuntimeError("profile identity mismatch: " + name)
    if tags.get("dev.agentbrowse.managed") != "true" or tags.get("dev.agentbrowse.role") != "browser-profile" or tags.get("dev.agentbrowse.profile.schema") != "1":
        raise RuntimeError("profile has no exact ownership evidence: " + name)
    return profile


def sparse_hash(path):
    """Hash allocated extents and their offsets without reading sparse holes."""
    digest = hashlib.sha256()
    size = path.stat().st_size
    digest.update(str(size).encode())
    with path.open("rb") as f:
        offset = 0
        while offset < size:
            try:
                start = os.lseek(f.fileno(), offset, os.SEEK_DATA)
            except OSError as error:
                if error.errno == errno.ENXIO:
                    break
                raise
            end = min(os.lseek(f.fileno(), start, os.SEEK_HOLE), size)
            digest.update(("%d:%d:" % (start, end)).encode())
            f.seek(start)
            remaining = end - start
            while remaining:
                data = f.read(min(remaining, 1024 * 1024))
                if not data:
                    raise RuntimeError("short image read")
                digest.update(data)
                remaining -= len(data)
            offset = end
    return digest.hexdigest()


def inventory():
    if MAC:
        source_root = Path.home() / "Library/Application Support/agentbrowse-infra"
        if (source_root / "OWNED").read_text().strip() != "agentbrowse-infra-owned-v1":
            raise RuntimeError("Apple source has no ownership marker")
        result = []
        for path in sorted((source_root / "runtime/volumes").glob("*/entity.json")):
            entity = json.loads(path.read_text())
            source = path.parent / "volume.img"
            name = profile_name(entity["name"], entity.get("labels", {}))
            if source.is_symlink() or entity["source"] != str(source) or not source.is_file():
                raise RuntimeError("unexpected Apple volume source")
            result.append({"profile": name, "name": entity["name"], "source": str(source), "tags": entity["labels"]})
        return result
    names = run(["docker", "volume", "ls", "-q"], capture_output=True, text=True).stdout.split()
    if not names:
        return []
    result = []
    for volume in json_command(["docker", "volume", "inspect", *names]):
        name = profile_name(volume["Name"], volume.get("Labels") or {})
        if volume["Driver"] != "local" or volume.get("Options"):
            raise RuntimeError("unsupported Docker volume driver/options")
        result.append({"profile": name, "name": volume["Name"], "source": volume["Mountpoint"], "tags": volume["Labels"]})
    return result


def stop_sources():
    if MAC:
        rows = json_command(["/usr/local/bin/container", "list", "--all", "--format", "json"])
        for row in rows:
            config = row["configuration"]
            labels = config.get("labels", {})
            if labels.get("dev.agentbrowse.managed") != "true" or labels.get("dev.agentbrowse.role") != "kernel-browser":
                raise RuntimeError("foreign Apple container prevents retirement")
        for row in rows:
            if str(row.get("status", "")).lower() == "running":
                run(["/usr/local/bin/container", "stop", row["configuration"]["id"]])
    else:
        ids = run(["docker", "ps", "-aq"], capture_output=True, text=True).stdout.split()
        rows = json_command(["docker", "inspect", *ids]) if ids else []
        for row in rows:
            labels = row["Config"].get("Labels") or {}
            if labels.get("dev.agentbrowse.managed") != "true" or labels.get("dev.agentbrowse.role") != "kernel-browser":
                raise RuntimeError("foreign Docker container prevents retirement")
        for row in rows:
            if row["State"]["Running"]:
                run(["docker", "stop", "--time", "30", row["Id"]])


def migrate(backend):
    API["owned"](ROOT)
    sources = inventory()  # Prove the whole source inventory before stopping anything.
    stop_sources()
    receipts = ROOT / "migration"
    receipts.mkdir(mode=0o700, exist_ok=True)
    volumes = API["request"](ROOT, "GET", "/volumes")
    for source in sources:
        receipt = receipts / (source["name"] + ".json")
        tags = {**source["tags"], "dev.agentbrowse.backend": backend}
        saved = json.loads(receipt.read_text()) if receipt.exists() else None
        existing = next((v for v in volumes if v["name"] == source["name"]), None)
        if saved:
            if saved["source"] != source or saved["backend"] != backend or not existing or existing["id"] != saved["volumeId"]:
                raise RuntimeError("migration receipt conflicts with current source/destination")
            if saved["complete"]:
                continue
        elif existing:
            raise RuntimeError("destination already exists without a migration receipt: " + source["name"])
        size_gb = (Path(source["source"]).stat().st_size + 1024**3 - 1) // 1024**3 if MAC else 10
        if not existing:
            existing = API["request"](ROOT, "POST", "/volumes", {"name": source["name"], "size_gb": size_gb, "tags": tags})
            volumes.append(existing)
        saved = {"version": 1, "source": source, "backend": backend, "volumeId": existing["id"], "complete": False}
        API["write_private"](receipt, json.dumps(saved, indent=2) + "\n")
        if existing.get("tags") != tags:
            raise RuntimeError("destination profile tags changed")
        instances = API["request"](ROOT, "GET", "/instances")
        if any(m["volume_id"] == existing["id"] for i in instances for m in i.get("volumes", [])):
            raise RuntimeError("destination volume is attached; refusing offline copy")
        volume_dir = ROOT / "data/volumes" / existing["id"]
        raw = volume_dir / "data.raw"
        temporary = volume_dir / "migration.raw"
        if raw.is_symlink() or temporary.is_symlink():
            raise RuntimeError("unsafe destination disk path")
        if temporary.exists():
            temporary.unlink()  # The matching incomplete receipt owns this staging disk.
        if MAC:
            run(["cp", "-c", source["source"], temporary])
            if sparse_hash(Path(source["source"])) != sparse_hash(temporary):
                raise RuntimeError("cloned Apple profile verification failed")
            check = subprocess.run(["/opt/homebrew/opt/e2fsprogs/sbin/e2fsck", "-fn", temporary], capture_output=True, text=True)
            if check.returncode:
                raise RuntimeError("Apple profile filesystem check failed: " + check.stderr[-500:])
        else:
            with temporary.open("xb") as f:
                f.truncate(size_gb * 1024**3)
            run(["mkfs.ext4", "-q", "-F", "-d", source["source"], temporary])
            with tempfile.TemporaryDirectory(prefix="agentbrowse-verify-") as mount:
                run(["mount", "-o", "loop,ro", temporary, mount])
                try:
                    run(["diff", "-qr", "--no-dereference", "--exclude=lost+found", source["source"], mount], stdout=subprocess.DEVNULL)
                finally:
                    run(["umount", mount])
        with temporary.open("rb") as f:
            os.fsync(f.fileno())
        temporary.replace(raw)
        saved["complete"] = True
        API["write_private"](receipt, json.dumps(saved, indent=2) + "\n")
        print(json.dumps({"migrated": source["profile"], "backend": backend}), flush=True)
    print(json.dumps({"verifiedProfiles": len(sources), "sourceDataPreserved": True}))


def compact_profiles():
    """Pinned v0.3.0 offline ext4 layout; only detached migration-owned volumes.

    Keep the original disk until the resized copy passes e2fsck. Hypeman has no
    shrink API; reload the service after this explicit one-time metadata change.
    """
    API["owned"](ROOT)
    tools = Path("/opt/homebrew/opt/e2fsprogs/sbin") if MAC else Path("/sbin")
    volumes = {v["id"]: v for v in API["request"](ROOT, "GET", "/volumes")}
    for receipt in sorted((ROOT / "migration").glob("*.json")):
        saved = json.loads(receipt.read_text())
        if not saved["complete"]:
            raise RuntimeError("finish migration before compaction")
        volume = volumes[saved["volumeId"]]
        if volume["name"] != saved["source"]["name"]:
            raise RuntimeError("volume no longer matches migration receipt")
        if saved.get("compacted"):
            continue
        instances = API["request"](ROOT, "GET", "/instances")
        if any(m["volume_id"] == volume["id"] for i in instances for m in i.get("volumes", [])):
            raise RuntimeError("refusing to compact an attached profile")
        directory = ROOT / "data/volumes" / volume["id"]
        raw = directory / "data.raw"
        copy = directory / "compact.raw"
        if copy.is_symlink():
            raise RuntimeError("unsafe compaction staging disk")
        if copy.exists():
            copy.unlink()  # Matching uncompacted migration receipt owns this temporary copy.
        run(["cp", "-c" if MAC else "--sparse=always", raw, copy])
        check = subprocess.run([tools / "e2fsck", "-fy", copy], capture_output=True)
        if check.returncode not in (0, 1):
            raise RuntimeError("profile filesystem repair refused; original retained")
        estimate = run([tools / "resize2fs", "-P", copy], capture_output=True, text=True).stdout
        header = run([tools / "dumpe2fs", "-h", copy], capture_output=True, text=True).stdout
        blocks = int(re.search(r"filesystem: (\d+)", estimate).group(1))
        block_size = int(re.search(r"Block size:\s+(\d+)", header).group(1))
        size_gb = max(1, (blocks * block_size * 12 // 10 + 1024**3 - 1) // 1024**3)
        run([tools / "resize2fs", copy, str(size_gb) + "G"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        # resize2fs updates filesystem size; truncate excess backing bytes explicitly.
        with copy.open("r+b") as f:
            f.truncate(size_gb * 1024**3)
            os.fsync(f.fileno())
        run([tools / "e2fsck", "-fn", copy], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        metadata = directory / "metadata.json"
        meta = json.loads(metadata.read_text())
        if meta["id"] != volume["id"] or meta["name"] != volume["name"] or meta.get("attachments"):
            raise RuntimeError("volume metadata changed during compaction")
        copy.replace(raw)
        meta["size_gb"] = size_gb
        API["write_private"](metadata, json.dumps(meta, indent=2) + "\n")
        saved["compacted"] = True
        API["write_private"](receipt, json.dumps(saved, indent=2) + "\n")
        print(json.dumps({"compacted": volume["name"], "sizeGb": size_gb}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend")
    parser.add_argument("--compact", action="store_true")
    args = parser.parse_args()
    if not args.compact and (not args.backend or not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", args.backend)):
        parser.error("invalid backend identity")
    try:
        if args.compact:
            compact_profiles()
        else:
            migrate(args.backend)
            compact_profiles()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print("profile migration: " + str(error), file=sys.stderr)
        sys.exit(1)
