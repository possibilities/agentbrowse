#!/usr/bin/env python3
"""Measure, back up, inspect, and restore complete AgentBrowse profile volumes.

The backup format is deliberately separate from Kernel's native profile archive.
It preserves complete detached Hypeman ext4 images for host recovery and never
copies AgentBrowse leases, target receipts, credentials, SSH material, or
connection descriptors.
"""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import runpy
import shutil
import statistics
import subprocess
import sys
import uuid


FORMAT = "agentbrowse-hypeman-profile-backup"
FORMAT_VERSION = 1
PROFILE_SCHEMA_VERSION = "1"
PROFILE = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
VOLUME_ID = re.compile(r"[A-Za-z0-9_-]+\Z")
CHUNK_BYTES = 1024 * 1024
SAMPLE_CHUNKS = 16


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def write_private(api, path, value):
    del api  # Keep the call shape shared with other host tools; durability is local here.
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(".%s.%d.%s.tmp" % (path.name, os.getpid(), uuid.uuid4().hex))
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        os.chmod(path, 0o600)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def sha256_file(path):
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while True:
            block = stream.read(CHUNK_BYTES)
            if not block:
                return digest.hexdigest(), size
            digest.update(block)
            size += len(block)


def fingerprint(path):
    details = path.stat()
    return {
        "device": details.st_dev,
        "inode": details.st_ino,
        "bytes": details.st_size,
        "mtimeNs": details.st_mtime_ns,
        "ctimeNs": details.st_ctime_ns,
    }


def executable(name, env_name=None):
    override = os.environ.get(env_name) if env_name else None
    found = shutil.which(override or name)
    if not found:
        raise RuntimeError("%s is required" % name)
    return found


def e2fsck_path():
    override = os.environ.get("AGENTBROWSE_E2FSCK")
    candidates = [override] if override else []
    candidates += ["/opt/homebrew/opt/e2fsprogs/sbin/e2fsck", "/sbin/e2fsck"]
    candidates += [shutil.which("e2fsck")]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise RuntimeError("e2fsck is required for clean offline profile verification")


def check_filesystem(path):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("unsafe profile image path")
    result = subprocess.run(
        [e2fsck_path(), "-fn", str(path)], capture_output=True, text=True
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout)[-500:].strip()
        raise RuntimeError("profile filesystem is not clean: " + detail)


def profile_from_volume(volume, backend):
    tags = volume.get("tags") or {}
    profile = tags.get("dev.agentbrowse.profile", "")
    expected = "agentbrowse-profile-" + profile
    if (
        not PROFILE.fullmatch(profile)
        or volume.get("name") != expected
        or tags.get("dev.agentbrowse.managed") != "true"
        or tags.get("dev.agentbrowse.role") != "browser-profile"
        or tags.get("dev.agentbrowse.backend") != backend
        or tags.get("dev.agentbrowse.profile.schema") != PROFILE_SCHEMA_VERSION
    ):
        raise RuntimeError("profile volume ownership mismatch: " + str(volume.get("name")))
    if not VOLUME_ID.fullmatch(str(volume.get("id", ""))):
        raise RuntimeError("unsafe profile volume identity")
    size_gib = volume.get("size_gb")
    if not isinstance(size_gib, int) or isinstance(size_gib, bool) or size_gib < 1:
        raise RuntimeError("profile volume has invalid reserved capacity")
    return profile


def sanitized_volume(volume, backend):
    profile = profile_from_volume(volume, backend)
    return {
        "id": volume["id"],
        "name": volume["name"],
        "profile": profile,
        "sizeGiB": volume["size_gb"],
        "profileSchema": PROFILE_SCHEMA_VERSION,
    }


def source_record(row, backend, image_fingerprint=None):
    return {
        "volume": sanitized_volume(row["volume"], backend),
        "fingerprint": image_fingerprint or fingerprint(row["raw"]),
        "metadataSha256": hashlib.sha256(row["metadataBytes"]).hexdigest(),
    }


def load_inventory(api, root, backend):
    api["owned"](root)
    volumes = api["request"](root, "GET", "/volumes")
    instances = api["request"](root, "GET", "/instances")
    attachments = {}
    for instance in instances:
        for mount in instance.get("volumes", []):
            identity = mount.get("volume_id")
            if identity:
                attachments.setdefault(identity, []).append(str(instance.get("name", "unknown")))
    profiles = []
    findings = []
    for volume in volumes:
        tags = volume.get("tags") or {}
        owned_role = (
            tags.get("dev.agentbrowse.managed") == "true"
            and tags.get("dev.agentbrowse.role") == "browser-profile"
        )
        familiar_name = str(volume.get("name", "")).startswith("agentbrowse-profile-")
        if not owned_role and not familiar_name:
            continue
        try:
            profile = profile_from_volume(volume, backend)
            directory = root / "data/volumes" / volume["id"]
            metadata_path = directory / "metadata.json"
            raw = directory / "data.raw"
            if directory.is_symlink() or metadata_path.is_symlink() or raw.is_symlink():
                raise RuntimeError("profile volume contains a symlinked storage path")
            metadata = json.loads(metadata_path.read_text())
            if (
                metadata.get("id") != volume["id"]
                or metadata.get("name") != volume["name"]
                or metadata.get("tags") != volume.get("tags")
                or metadata.get("size_gb") != volume.get("size_gb")
            ):
                raise RuntimeError("Hypeman API and disk metadata disagree")
            attached = sorted(attachments.get(volume["id"], []))
            if metadata.get("attachments"):
                raise RuntimeError("disk metadata records a profile attachment")
            profiles.append(
                {
                    "profile": profile,
                    "volume": volume,
                    "metadata": metadata,
                    "metadataBytes": metadata_path.read_bytes(),
                    "raw": raw,
                    "attachedTo": attached,
                }
            )
            if attached:
                findings.append(
                    {
                        "severity": "error",
                        "code": "attached",
                        "profile": profile,
                        "detail": "volume is attached to " + ", ".join(attached),
                    }
                )
        except (KeyError, OSError, ValueError, RuntimeError) as error:
            findings.append(
                {
                    "severity": "error",
                    "code": "volume_reconciliation_failed",
                    "volume": str(volume.get("name", "unknown")),
                    "detail": str(error),
                }
            )
    profiles.sort(key=lambda row: row["profile"])
    for left, right in zip(profiles, profiles[1:]):
        if left["profile"] == right["profile"]:
            findings.append(
                {
                    "severity": "error",
                    "code": "duplicate_profile_volume",
                    "profile": left["profile"],
                    "detail": "more than one owned volume has this logical profile name",
                }
            )
    return profiles, findings


def estimate_compression(path):
    zstd = executable("zstd", "AGENTBROWSE_ZSTD")
    size = path.stat().st_size
    if size == 0:
        return {
            "bytes": 0,
            "uncertaintyBytes": 0,
            "method": "stratified-zstd-level-3-v1",
            "sampleBytes": 0,
            "sampleChunks": 0,
        }
    chunks = min(SAMPLE_CHUNKS, max(1, math.ceil(size / CHUNK_BYTES)))
    offsets = [0] if chunks == 1 else [
        ((size - min(CHUNK_BYTES, size)) * index) // (chunks - 1) for index in range(chunks)
    ]
    ratios = []
    sampled = 0
    with path.open("rb") as stream:
        for offset in offsets:
            stream.seek(offset)
            data = stream.read(min(CHUNK_BYTES, size - offset))
            result = subprocess.run(
                [zstd, "-q", "-3", "--check", "-c"],
                input=data,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            if result.returncode:
                raise RuntimeError("zstd compression estimate failed")
            ratios.append(len(result.stdout) / len(data))
            sampled += len(data)
    mean = statistics.fmean(ratios)
    standard_error = statistics.stdev(ratios) / math.sqrt(len(ratios)) if len(ratios) > 1 else 0
    # Include one sample-chunk of model error: independent frames, metadata and
    # ext4 locality make the statistical interval optimistic on tiny samples.
    uncertainty = min(size, math.ceil(size * 1.96 * standard_error + CHUNK_BYTES))
    return {
        "bytes": min(size, math.ceil(size * mean)),
        "uncertaintyBytes": uncertainty,
        "method": "stratified-zstd-level-3-v1",
        "sampleBytes": sampled,
        "sampleChunks": len(ratios),
    }


def unit_summary(values):
    def decimal(value):
        return {
            "bytes": value,
            "kilobytes": value / 1000,
            "megabytes": value / 1000 ** 2,
            "gigabytes": value / 1000 ** 3,
        }

    def binary(value):
        return {
            "bytes": value,
            "kibibytes": value / 1024,
            "mebibytes": value / 1024 ** 2,
            "gibibytes": value / 1024 ** 3,
        }

    return {
        "bytes": values,
        "decimal": {key: decimal(value) for key, value in values.items()},
        "binary": {key: binary(value) for key, value in values.items()},
    }


def measure(api, root, backend, compression_estimate):
    profiles, findings = load_inventory(api, root, backend)
    rows = []
    for row in profiles:
        details = row["raw"].stat()
        estimate = estimate_compression(row["raw"]) if compression_estimate else None
        rows.append(
            {
                "profile": row["profile"],
                "volume": row["volume"]["id"],
                "reservedBytes": row["volume"]["size_gb"] * 1024 ** 3,
                "rawLogicalBytes": details.st_size,
                "physicalAllocatedBytes": details.st_blocks * 512,
                "attached": bool(row["attachedTo"]),
                **({"compressionEstimate": estimate} if estimate else {}),
            }
        )
    values = {
        "reserved": sum(row["reservedBytes"] for row in rows),
        "rawLogical": sum(row["rawLogicalBytes"] for row in rows),
        "physicalAllocated": sum(row["physicalAllocatedBytes"] for row in rows),
        "expectedCompressed": sum(
            row.get("compressionEstimate", {}).get("bytes", 0) for row in rows
        ),
        "compressionUncertainty": sum(
            row.get("compressionEstimate", {}).get("uncertaintyBytes", 0) for row in rows
        ),
    }
    return {
        "formatVersion": 1,
        "backend": backend,
        "profileCount": len(rows),
        "reconciliationFindings": findings,
        "profiles": rows,
        "totals": unit_summary(values),
        "compressionEstimate": {
            "requested": compression_estimate,
            "method": "stratified-zstd-level-3-v1" if compression_estimate else None,
            "uncertainty": "95% sample interval plus one MiB per profile; ext4 locality may exceed it",
        },
    }


def detached(api, root, identity):
    return not any(
        mount.get("volume_id") == identity
        for instance in api["request"](root, "GET", "/instances")
        for mount in instance.get("volumes", [])
    )


def assert_clean_detached(api, root, row):
    identity = row["volume"]["id"]
    current = {
        volume.get("id"): volume
        for volume in api["request"](root, "GET", "/volumes")
    }.get(identity)
    if current != row["volume"]:
        raise RuntimeError("profile volume metadata changed during consistency check")
    if row["attachedTo"] or not detached(api, root, identity):
        raise RuntimeError("profile is attached: " + row["profile"])
    before = fingerprint(row["raw"])
    check_filesystem(row["raw"])
    if fingerprint(row["raw"]) != before or not detached(api, root, identity):
        raise RuntimeError("profile image changed or became attached during filesystem verification")
    return before


def verify_compressed(zstd_command, archive, expected_hash, expected_size):
    process = subprocess.Popen(
        [zstd_command, "-q", "-d", "-c", str(archive)], stdout=subprocess.PIPE
    )
    digest = hashlib.sha256()
    size = 0
    try:
        while True:
            block = process.stdout.read(CHUNK_BYTES)
            if not block:
                break
            digest.update(block)
            size += len(block)
    finally:
        process.stdout.close()
    if process.wait() or (digest.hexdigest(), size) != (expected_hash, expected_size):
        raise RuntimeError("compressed profile image verification failed")


def start_archive(source, temporary, recipients, unencrypted):
    zstd_command = executable("zstd", "AGENTBROWSE_ZSTD")
    age_command = None if unencrypted else executable("age", "AGENTBROWSE_AGE")
    compressed = temporary.with_name(temporary.name + ".zstd")
    try:
        with compressed.open("xb") as output:
            os.chmod(compressed, 0o600)
            zstd = subprocess.Popen(
                [zstd_command, "-q", "-T2", "-3", "--check", "-c"],
                stdin=subprocess.PIPE,
                stdout=output,
            )
            digest = hashlib.sha256()
            size = 0
            try:
                with source.open("rb") as stream:
                    while True:
                        block = stream.read(CHUNK_BYTES)
                        if not block:
                            break
                        digest.update(block)
                        size += len(block)
                        zstd.stdin.write(block)
            finally:
                zstd.stdin.close()
            if zstd.wait():
                raise RuntimeError("profile image compression failed")
            output.flush()
            os.fsync(output.fileno())
        raw_hash = digest.hexdigest()
        verify_compressed(zstd_command, compressed, raw_hash, size)
        if unencrypted:
            compressed.replace(temporary)
        else:
            command = [age_command]
            for recipient in recipients:
                command += ["-r", recipient]
            with compressed.open("rb") as source_stream, temporary.open("xb") as output:
                os.chmod(temporary, 0o600)
                result = subprocess.run(command, stdin=source_stream, stdout=output)
                if result.returncode:
                    raise RuntimeError("profile archive encryption failed")
                output.flush()
                os.fsync(output.fileno())
        return raw_hash, size
    finally:
        compressed.unlink(missing_ok=True)


def backup(api, root, backend, destination, recipients, unencrypted, dry_run):
    if not destination.is_absolute() or destination.is_symlink():
        raise RuntimeError("backup set path must be absolute and must not be a symlink")
    profiles, findings = load_inventory(api, root, backend)
    if findings:
        raise RuntimeError("profile inventory has reconciliation findings; run backup measure")
    plan = {
        "backend": backend,
        "destination": str(destination),
        "profileCount": len(profiles),
        "profiles": [row["profile"] for row in profiles],
        "encrypted": not unencrypted,
        "dryRun": dry_run,
    }
    if dry_run:
        for row in profiles:
            assert_clean_detached(api, root, row)
        return plan
    if not unencrypted and not recipients:
        raise RuntimeError(
            "authenticated encryption is the default; pass at least one age --recipient "
            "(or explicitly acknowledge plaintext with --unencrypted)"
        )
    executable("zstd", "AGENTBROWSE_ZSTD")
    if not unencrypted:
        executable("age", "AGENTBROWSE_AGE")
    if destination.exists() and (destination / "manifest.json").exists():
        manifest = inspect_set(destination)
        if manifest["source"]["backend"] != backend:
            raise RuntimeError("completed backup set belongs to another backend")
        requested_encryption = {
            "method": "none-explicit" if unencrypted else "age-x25519",
            "recipients": [] if unencrypted else sorted(set(recipients)),
        }
        if manifest.get("encryption") != requested_encryption:
            raise RuntimeError("completed backup set used different encryption options")
        if [entry["profile"] for entry in manifest["profiles"]] != [
            row["profile"] for row in profiles
        ]:
            raise RuntimeError("completed backup set no longer matches the source inventory")
        for row, entry in zip(profiles, manifest["profiles"]):
            before = assert_clean_detached(api, root, row)
            if entry["source"] != source_record(row, backend, before):
                raise RuntimeError("completed backup set no longer matches its source volume")
        return {**plan, "complete": True, "resumed": True}
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination, 0o700)
    profiles_directory = destination / "profiles"
    profiles_directory.mkdir(mode=0o700, exist_ok=True)
    entries = []
    for row in profiles:
        before = assert_clean_detached(api, root, row)
        directory = profiles_directory / row["profile"]
        directory.mkdir(mode=0o700, exist_ok=True)
        archive_name = "data.raw.zst" + ("" if unencrypted else ".age")
        archive = directory / archive_name
        receipt = directory / "entry.json"
        expected_source = source_record(row, backend, before)
        if receipt.exists():
            entry = json.loads(receipt.read_text())
            if entry.get("source") != expected_source or not archive.is_file():
                raise RuntimeError("backup resume receipt conflicts with current source")
            stored_hash, stored_size = sha256_file(archive)
            if (
                stored_hash != entry["archive"]["sha256"]
                or stored_size != entry["archive"]["bytes"]
            ):
                raise RuntimeError("backup archive changed after publication")
            if (
                row["metadataBytes"]
                != (
                    root / "data/volumes" / row["volume"]["id"] / "metadata.json"
                ).read_bytes()
                or not detached(api, root, row["volume"]["id"])
            ):
                raise RuntimeError("profile changed or became attached during backup resume")
            entries.append(entry)
            continue
        temporary = directory / (archive_name + ".partial")
        compressed_temporary = temporary.with_name(temporary.name + ".zstd")
        for stale in (temporary, compressed_temporary, archive):
            if stale.is_symlink():
                raise RuntimeError("unsafe backup staging path")
            if stale.exists():
                if not stale.is_file():
                    raise RuntimeError("unsafe backup staging path")
                stale.unlink()
        raw_hash, raw_size = start_archive(
            row["raw"], temporary, recipients, unencrypted
        )
        if (
            fingerprint(row["raw"]) != before
            or row["metadataBytes"]
            != (
                root / "data/volumes" / row["volume"]["id"] / "metadata.json"
            ).read_bytes()
            or not detached(api, root, row["volume"]["id"])
        ):
            raise RuntimeError("profile changed or became attached during backup")
        temporary.replace(archive)
        stored_hash, stored_size = sha256_file(archive)
        entry = {
            "version": 1,
            "profile": row["profile"],
            "source": expected_source,
            "filesystem": {"type": "ext4", "check": "e2fsck-fn-clean"},
            "archive": {
                "path": "profiles/%s/%s" % (row["profile"], archive_name),
                "bytes": stored_size,
                "sha256": stored_hash,
                "rawBytes": raw_size,
                "rawSha256": raw_hash,
                "compression": "zstd-level-3",
                "encryption": "none-explicit" if unencrypted else "age-x25519",
            },
        }
        write_private(api, receipt, entry)
        entries.append(entry)
    manifest = {
        "format": FORMAT,
        "version": FORMAT_VERSION,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": {
            "backend": backend,
            "platform": platform.system().lower(),
            "hypeman": "0.3.0",
            "profileSchema": PROFILE_SCHEMA_VERSION,
        },
        "encryption": {
            "method": "none-explicit" if unencrypted else "age-x25519",
            "recipients": [] if unencrypted else sorted(set(recipients)),
        },
        "profiles": entries,
    }
    # Publication point: an absent manifest always means the set is incomplete.
    write_private(api, destination / "manifest.json", manifest)
    return {**plan, "complete": True, "resumed": False}


def validate_entry_path(root, entry):
    profile = entry.get("profile", "")
    if not PROFILE.fullmatch(profile):
        raise RuntimeError("backup entry has an invalid logical profile name")
    expected = "profiles/%s/%s" % (
        profile,
        "data.raw.zst.age"
        if entry.get("archive", {}).get("encryption") == "age-x25519"
        else "data.raw.zst",
    )
    if entry.get("archive", {}).get("path") != expected:
        raise RuntimeError("backup entry has an unsafe archive path")
    source = entry.get("source")
    volume = source.get("volume") if isinstance(source, dict) else None
    archive_record = entry.get("archive")
    if (
        not isinstance(volume, dict)
        or volume.get("profile") != profile
        or volume.get("name") != "agentbrowse-profile-" + profile
        or not VOLUME_ID.fullmatch(str(volume.get("id", "")))
        or not isinstance(volume.get("sizeGiB"), int)
        or isinstance(volume.get("sizeGiB"), bool)
        or volume["sizeGiB"] < 1
        or volume["sizeGiB"] > 1024
        or not isinstance(archive_record, dict)
    ):
        raise RuntimeError("backup entry recovery metadata is invalid")
    for key in ("bytes", "rawBytes"):
        if (
            not isinstance(archive_record.get(key), int)
            or isinstance(archive_record.get(key), bool)
            or archive_record[key] < 0
        ):
            raise RuntimeError("backup entry has an invalid image size")
    if archive_record["rawBytes"] > volume["sizeGiB"] * 1024 ** 3:
        raise RuntimeError("backup image exceeds its recorded volume capacity")
    for key in ("sha256", "rawSha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", str(archive_record.get(key, ""))):
            raise RuntimeError("backup entry has an invalid digest")
    path = root / expected
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("backup archive is missing or unsafe")
    digest, size = sha256_file(path)
    if digest != entry["archive"].get("sha256") or size != entry["archive"].get("bytes"):
        raise RuntimeError("backup archive integrity check failed")
    return path


def inspect_set(path):
    if not path.is_absolute() or path.is_symlink():
        raise RuntimeError("backup set path must be absolute and must not be a symlink")
    manifest_path = path / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError("backup set is incomplete: manifest.json is absent")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("format") != FORMAT or manifest.get("version") != FORMAT_VERSION:
        raise RuntimeError("unsupported backup set format")
    profiles = manifest.get("profiles")
    if not isinstance(profiles, list):
        raise RuntimeError("backup manifest profiles are invalid")
    names = []
    for entry in profiles:
        if not isinstance(entry, dict) or entry.get("version") != 1:
            raise RuntimeError("backup manifest entry is invalid")
        validate_entry_path(path, entry)
        if entry["archive"]["encryption"] != manifest.get("encryption", {}).get("method"):
            raise RuntimeError("backup manifest encryption metadata disagrees with an entry")
        names.append(entry["profile"])
    if names != sorted(set(names)):
        raise RuntimeError("backup manifest profile order or uniqueness is invalid")
    return manifest


def list_sets(destination):
    if not destination.is_absolute() or destination.is_symlink() or not destination.is_dir():
        raise RuntimeError("backup collection must be an absolute, non-symlink directory")
    sets = []
    for child in sorted(destination.iterdir()):
        if child.is_symlink() or not child.is_dir() or not (child / "manifest.json").is_file():
            continue
        manifest = inspect_set(child)
        sets.append(
            {
                "path": str(child),
                "createdAt": manifest["createdAt"],
                "sourceBackend": manifest["source"]["backend"],
                "profileCount": len(manifest["profiles"]),
                "encryption": manifest["encryption"]["method"],
            }
        )
    return {"sets": sets, "count": len(sets)}


def extract_archive(archive, output, entry, identity):
    encryption = entry["archive"]["encryption"]
    if encryption == "age-x25519":
        if not identity:
            raise RuntimeError("encrypted backup restore requires an age --identity file")
        if not Path(identity).is_absolute():
            raise RuntimeError("age identity path must be absolute on the destination host")
        age = subprocess.Popen(
            [executable("age", "AGENTBROWSE_AGE"), "-d", "-i", identity, str(archive)],
            stdout=subprocess.PIPE,
        )
        compressed = age.stdout
    elif encryption == "none-explicit":
        age = None
        compressed = archive.open("rb")
    else:
        raise RuntimeError("unsupported backup encryption method")
    zstd = subprocess.Popen(
        [executable("zstd", "AGENTBROWSE_ZSTD"), "-q", "-d", "-c"],
        stdin=compressed,
        stdout=subprocess.PIPE,
    )
    compressed.close()
    digest = hashlib.sha256()
    size = 0
    try:
        with output.open("xb") as stream:
            os.chmod(output, 0o600)
            while True:
                block = zstd.stdout.read(CHUNK_BYTES)
                if not block:
                    break
                stream.write(block)
                digest.update(block)
                size += len(block)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        zstd.stdout.close()
    zstd_code = zstd.wait()
    age_code = age.wait() if age else 0
    if zstd_code or age_code:
        raise RuntimeError("backup decryption or decompression failed")
    if digest.hexdigest() != entry["archive"]["rawSha256"] or size != entry["archive"]["rawBytes"]:
        raise RuntimeError("restored profile image digest does not match the backup")


def destination_tags(profile, backend):
    return {
        "dev.agentbrowse.managed": "true",
        "dev.agentbrowse.backend": backend,
        "dev.agentbrowse.role": "browser-profile",
        "dev.agentbrowse.profile": profile,
        "dev.agentbrowse.profile.schema": PROFILE_SCHEMA_VERSION,
    }


def restore(api, root, backend, source, identity, dry_run):
    manifest = inspect_set(source)
    if not dry_run:
        executable("zstd", "AGENTBROWSE_ZSTD")
        e2fsck_path()
        if manifest.get("encryption", {}).get("method") == "age-x25519":
            if not identity:
                raise RuntimeError("encrypted backup restore requires an age --identity file")
            identity_path = Path(identity)
            if not identity_path.is_absolute():
                raise RuntimeError("age identity path must be absolute on the destination host")
            if identity_path.is_symlink() or not identity_path.is_file():
                raise RuntimeError("age identity must be a regular non-symlink file")
            executable("age", "AGENTBROWSE_AGE")
    api["owned"](root)
    volumes = api["request"](root, "GET", "/volumes")
    instances = api["request"](root, "GET", "/instances")
    attached = {m.get("volume_id") for i in instances for m in i.get("volumes", [])}
    by_name = {volume["name"]: volume for volume in volumes}
    if len(by_name) != len(volumes):
        raise RuntimeError("destination contains duplicate Hypeman volume names")
    set_digest = hashlib.sha256(canonical(manifest).encode()).hexdigest()
    receipts = root / "profile-restores" / set_digest
    plans = []
    for entry in manifest["profiles"]:
        profile = entry["profile"]
        name = "agentbrowse-profile-" + profile
        if name in by_name:
            receipt_path = receipts / (profile + ".json")
            saved = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
            if (
                not saved
                or saved.get("volumeId") != by_name[name].get("id")
                or saved.get("profile") != profile
                or saved.get("setDigest") != set_digest
            ):
                raise RuntimeError("destination profile already exists: " + profile)
            action = "already-restored" if saved.get("complete") else "resume-publish"
        else:
            action = "create-fresh-volume"
        plans.append({"profile": profile, "name": name, "action": action})
    result = {
        "source": str(source),
        "sourceBackend": manifest["source"]["backend"],
        "destinationBackend": backend,
        "profiles": plans,
        "dryRun": dry_run,
    }
    if dry_run:
        return result
    receipts.mkdir(parents=True, exist_ok=True, mode=0o700)
    completed = []
    for entry in manifest["profiles"]:
        profile = entry["profile"]
        receipt_path = receipts / (profile + ".json")
        saved = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
        if saved and saved.get("complete"):
            directory = root / "data/volumes" / saved["volumeId"]
            metadata = json.loads((directory / "metadata.json").read_text())
            raw = directory / "data.raw"
            if (
                metadata.get("name") != "agentbrowse-profile-" + profile
                or metadata.get("tags") != destination_tags(profile, backend)
                or saved["volumeId"] in attached
                or not detached(api, root, saved["volumeId"])
                or sha256_file(raw)
                != (entry["archive"]["rawSha256"], entry["archive"]["rawBytes"])
            ):
                raise RuntimeError("completed restore receipt no longer matches its fresh volume")
            check_filesystem(raw)
            completed.append(profile)
            continue
        if saved:
            if saved.get("profile") != profile or saved.get("setDigest") != set_digest:
                raise RuntimeError("restore receipt conflicts with this backup set")
            volume = next((v for v in volumes if v.get("id") == saved.get("volumeId")), None)
            if not volume:
                raise RuntimeError("incomplete restore destination volume is missing")
        else:
            staging_name = "agentbrowse-restore-" + uuid.uuid4().hex
            staging_tags = {
                "dev.agentbrowse.managed": "true",
                "dev.agentbrowse.backend": backend,
                "dev.agentbrowse.role": "profile-restore-staging",
                "dev.agentbrowse.restore.profile": profile,
            }
            volume = api["request"](
                root,
                "POST",
                "/volumes",
                {
                    "name": staging_name,
                    "size_gb": entry["source"]["volume"]["sizeGiB"],
                    "tags": staging_tags,
                },
            )
            volumes.append(volume)
            saved = {
                "version": 1,
                "setDigest": set_digest,
                "profile": profile,
                "volumeId": volume["id"],
                "complete": False,
            }
            write_private(api, receipt_path, saved)
        if volume["id"] in attached or not detached(api, root, volume["id"]):
            raise RuntimeError("restore staging volume became attached")
        directory = root / "data/volumes" / volume["id"]
        raw = directory / "data.raw"
        staging = directory / "restore.raw"
        if raw.is_symlink() or staging.is_symlink():
            raise RuntimeError("unsafe restore destination path")
        raw_hash, raw_size = sha256_file(raw)
        expected_hash = entry["archive"]["rawSha256"]
        expected_size = entry["archive"]["rawBytes"]
        if (raw_hash, raw_size) != (expected_hash, expected_size):
            if staging.exists():
                staging.unlink()
            extract_archive(validate_entry_path(source, entry), staging, entry, identity)
            check_filesystem(staging)
            staging.replace(raw)
        if sha256_file(raw) != (expected_hash, expected_size):
            raise RuntimeError("installed restore image failed its final digest check")
        check_filesystem(raw)
        metadata_path = directory / "metadata.json"
        metadata = json.loads(metadata_path.read_text())
        if (
            metadata.get("id") != volume["id"]
            or metadata.get("attachments")
            or not detached(api, root, volume["id"])
        ):
            raise RuntimeError("restore destination metadata changed or became attached")
        metadata["name"] = "agentbrowse-profile-" + profile
        metadata["tags"] = destination_tags(profile, backend)
        metadata["size_gb"] = entry["source"]["volume"]["sizeGiB"]
        write_private(api, metadata_path, metadata)
        saved["complete"] = True
        write_private(api, receipt_path, saved)
        completed.append(profile)
    return {**result, "dryRun": False, "complete": completed, "newVolumeIds": True}


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--root", type=Path, required=True)
    result.add_argument("--helper", type=Path, required=True)
    result.add_argument("--backend", required=True)
    commands = result.add_subparsers(dest="command", required=True)
    measure_parser = commands.add_parser("measure")
    measure_parser.add_argument("--compression-estimate", action="store_true")
    create = commands.add_parser("create")
    create.add_argument("--destination", type=Path, required=True)
    create.add_argument("--recipient", action="append", default=[])
    create.add_argument("--unencrypted", action="store_true")
    create.add_argument("--dry-run", action="store_true")
    listing = commands.add_parser("list")
    listing.add_argument("--destination", type=Path, required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--set", dest="backup_set", type=Path, required=True)
    restore_parser = commands.add_parser("restore")
    restore_parser.add_argument("--set", dest="backup_set", type=Path, required=True)
    restore_parser.add_argument("--identity")
    restore_parser.add_argument("--dry-run", action="store_true")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    api = runpy.run_path(str(args.helper))
    if args.command == "measure":
        output = measure(api, args.root, args.backend, args.compression_estimate)
    elif args.command == "create":
        output = backup(
            api,
            args.root,
            args.backend,
            args.destination,
            args.recipient,
            args.unencrypted,
            args.dry_run,
        )
    elif args.command == "list":
        output = list_sets(args.destination)
    elif args.command == "inspect":
        output = inspect_set(args.backup_set)
    else:
        output = restore(
            api, args.root, args.backend, args.backup_set, args.identity, args.dry_run
        )
    print(json.dumps(output, sort_keys=True), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print("AgentBrowse profile backup: " + str(error), file=sys.stderr)
        sys.exit(1)
