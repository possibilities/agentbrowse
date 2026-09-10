#!/usr/bin/env python3
"""Inventory or archive detached, generated Agentscrape profile volumes.

This operator recovery tool never deletes volumes. Backups are exact compressed
Hypeman filesystems, not Kernel profile archives. Restoration is an explicit
host recovery operation; do not pass these files to profile import.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys

PATTERN = re.compile(r"agentbrowse-profile-agentscrape-[0-9]+-[a-z0-9-]+\Z")


def digest_stream(stream):
    digest = hashlib.sha256()
    size = 0
    while True:
        block = stream.read(1024 * 1024)
        if not block:
            return digest.hexdigest(), size
        digest.update(block)
        size += len(block)


def verify_archive(archive, expected_hash, expected_size):
    process = subprocess.Popen(["zstd", "-q", "-d", "-c", str(archive)], stdout=subprocess.PIPE)
    try:
        actual_hash, actual_size = digest_stream(process.stdout)
    finally:
        process.stdout.close()
        code = process.wait()
    if code or (actual_hash, actual_size) != (expected_hash, expected_size):
        raise RuntimeError("archive verification failed")


def compress_verified(source, archive):
    if source.is_symlink() or not source.is_file():
        raise RuntimeError("unsafe source filesystem")
    before = source.stat()
    fingerprint = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    temporary = archive.with_suffix(".partial")
    with temporary.open("xb") as output:
        os.chmod(temporary, 0o600)
        process = subprocess.Popen(["zstd", "-q", "-T2", "-3", "--check", "-c"], stdin=subprocess.PIPE, stdout=output)
        digest = hashlib.sha256()
        try:
            with source.open("rb") as stream:
                while True:
                    block = stream.read(1024 * 1024)
                    if not block:
                        break
                    digest.update(block)
                    process.stdin.write(block)
        finally:
            process.stdin.close()
            code = process.wait()
        if code:
            raise RuntimeError("archive compression failed")
        output.flush()
        os.fsync(output.fileno())
    expected_hash = digest.hexdigest()
    verify_archive(temporary, expected_hash, before.st_size)
    if fingerprint(source.stat()) != fingerprint(before):
        raise RuntimeError("source changed during backup")
    if archive.exists():
        raise RuntimeError("refusing existing archive")
    temporary.rename(archive)
    return {"sha256": expected_hash, "bytes": before.st_size, "archive_bytes": archive.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--backend", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    if not args.destination.is_absolute() or args.destination.is_symlink():
        raise RuntimeError("destination must be an absolute, non-symlink directory")
    api = runpy.run_path(str(args.helper))
    api["owned"](args.root)
    def get(path):
        return api["request"](args.root, "GET", path)
    def detached(identity):
        return not any(m.get("volume_id") == identity for i in get("/instances") for m in i.get("volumes", []))
    if args.verify_only:
        manifest = json.loads((args.destination / "manifest.json").read_text())
        current = {v["id"]: v for v in get("/volumes")}
        verified = []
        for r in manifest:
            v = r["volume"]
            if r["backend"] != args.backend or not PATTERN.fullmatch(v["name"]) or not re.fullmatch(r"[a-zA-Z0-9_-]+", v["id"]):
                raise RuntimeError("backup ownership mismatch")
            if v["id"] not in current:
                continue
            if current[v["id"]]["name"] != v["name"] or current[v["id"]]["tags"] != v["tags"] or not detached(v["id"]):
                raise RuntimeError("volume changed or became attached")
            backup = args.destination / v["id"]
            directory = args.root / "data/volumes" / v["id"]
            if (directory / "metadata.json").read_bytes() != (backup / "metadata.json").read_bytes():
                raise RuntimeError("metadata changed since backup")
            archive = (backup / "data.raw.zst").stat()
            raw = (directory / "data.raw").stat()
            marker = (backup / "verified.json").stat()
            if archive.st_size != r["verification"]["archive_bytes"] or raw.st_size != r["verification"]["bytes"] or max(raw.st_ctime_ns, raw.st_mtime_ns) > archive.st_mtime_ns or max(archive.st_ctime_ns, archive.st_mtime_ns) > marker.st_mtime_ns:
                raise RuntimeError("filesystem or backup changed since verification")
            verified.append(v)
        print(json.dumps(verified), flush=True)
        return
    candidates = []
    for v in get("/volumes"):
        tags = v.get("tags", {})
        if not PATTERN.fullmatch(v["name"]):
            continue
        if tags.get("dev.agentbrowse.managed") != "true" or tags.get("dev.agentbrowse.role") != "browser-profile" or tags.get("dev.agentbrowse.backend") != args.backend or v["name"] != "agentbrowse-profile-" + tags.get("dev.agentbrowse.profile", ""):
            raise RuntimeError("generated profile ownership mismatch")
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", v["id"]):
            raise RuntimeError("unsafe volume identity")
        if detached(v["id"]):
            candidates.append(v)
    print(json.dumps({"backend": args.backend, "candidates": len(candidates), "reserved_gib": sum(v["size_gb"] for v in candidates), "apply": args.apply}), flush=True)
    if not args.apply:
        return
    if not shutil.which("zstd"):
        raise RuntimeError("zstd is required")
    args.destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(args.destination, 0o700)
    completed = []
    for v in candidates:
        directory = args.root / "data/volumes" / v["id"]
        metadata = directory / "metadata.json"
        source = metadata.read_bytes()
        record = json.loads(source)
        if record["id"] != v["id"] or record["name"] != v["name"] or record["tags"] != v["tags"] or not detached(v["id"]):
            raise RuntimeError("volume identity changed or became attached")
        backup = args.destination / v["id"]
        backup.mkdir(mode=0o700)
        verification = compress_verified(directory / "data.raw", backup / "data.raw.zst")
        if metadata.read_bytes() != source or not detached(v["id"]):
            raise RuntimeError("volume changed during backup")
        (backup / "metadata.json").write_bytes(source)
        os.chmod(backup / "metadata.json", 0o600)
        receipt = {"version": 1, "backend": args.backend, "volume": v, "verification": verification}
        (backup / "verified.json").write_text(json.dumps(receipt) + "\n")
        os.chmod(backup / "verified.json", 0o600)
        for path in (backup / "metadata.json", backup / "verified.json"):
            with path.open("rb") as f:
                os.fsync(f.fileno())
        completed.append(receipt)
        print(json.dumps({"verified": len(completed), "of": len(candidates), "archive_bytes": verification["archive_bytes"]}), flush=True)
    manifest = args.destination / "manifest.json"
    with manifest.open("x") as f:
        os.chmod(manifest, 0o600)
        json.dump(completed, f)
        f.flush()
        os.fsync(f.fileno())
    print(json.dumps({"complete": len(completed), "archive_bytes": sum(r["verification"]["archive_bytes"] for r in completed)}), flush=True)


if __name__ == "__main__":
    main()
