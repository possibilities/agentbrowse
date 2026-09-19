#!/usr/bin/env python3
"""Measure, back up, inspect, and restore complete AgentBrowse profile volumes.

The backup format is deliberately separate from Kernel's native profile archive.
It preserves complete detached Hypeman ext4 images for host recovery and never
copies AgentBrowse leases, target receipts, credentials, SSH material, or
connection descriptors.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import runpy
import shutil
import stat
import statistics
import subprocess
import sys
import tempfile
import uuid
from contextlib import contextmanager


FORMAT = "agentbrowse-hypeman-profile-backup"
FORMAT_VERSION = 1
PROFILE_SCHEMA_VERSION = "1"
PROFILE = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
BACKEND = re.compile(r"[a-z][a-z0-9-]{0,31}\Z")
VOLUME_ID = re.compile(r"[A-Za-z0-9_-]+\Z")
CHUNK_BYTES = 1024 * 1024
SAMPLE_CHUNKS = 16
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_VOLUME_GIB = (2 ** 63 - 1) // (1024 ** 3)
SPARSE_BLOCK_BYTES = 4096


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def value_digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def assert_no_symlink_components(path, allow_missing=False):
    """Reject links anywhere in a privileged path, including its ancestors."""
    path = Path(path)
    if not path.is_absolute():
        raise RuntimeError("privileged path must be absolute")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            os.lstat(current)
        except FileNotFoundError:
            if allow_missing:
                return
            raise RuntimeError("required path is missing: " + str(current))
        # macOS exposes these fixed, root-owned compatibility aliases. Treat
        # them as filesystem roots; all components below them remain checked.
        trusted_aliases = {"/var": "/private/var", "/tmp": "/private/tmp"}
        trusted_alias = (
            platform.system() == "Darwin"
            and str(current) in trusted_aliases
            and os.path.realpath(current) == trusted_aliases[str(current)]
            and os.lstat(current).st_uid == 0
        )
        if os.path.islink(current) and not trusted_alias:
            raise RuntimeError("symlinked path component is unsafe: " + str(current))


@contextmanager
def operation_lock(path):
    assert_no_symlink_components(path.parent, allow_missing=True)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert_no_symlink_components(path.parent)
    if path.is_symlink():
        raise RuntimeError("unsafe operation lock path")
    fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError("unsafe operation lock path")
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def write_private_bytes(path, value):
    assert_no_symlink_components(path.parent, allow_missing=True)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert_no_symlink_components(path.parent)
    temporary = path.with_name(".%s.%d.%s.tmp" % (path.name, os.getpid(), uuid.uuid4().hex))
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(value)
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


def write_private(api, path, value):
    del api  # Keep the call shape shared with other host tools; durability is local here.
    assert_no_symlink_components(path.parent, allow_missing=True)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    assert_no_symlink_components(path.parent)
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
    if (
        not isinstance(size_gib, int)
        or isinstance(size_gib, bool)
        or size_gib < 1
        or size_gib > MAX_VOLUME_GIB
    ):
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
    if not isinstance(backend, str) or not BACKEND.fullmatch(backend):
        raise RuntimeError("invalid profile backup backend")
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
    foreign_profiles = []
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
            tags = volume.get("tags") or {}
            declared_backend = tags.get("dev.agentbrowse.backend")
            if not isinstance(declared_backend, str) or not BACKEND.fullmatch(declared_backend):
                raise RuntimeError("profile volume has invalid backend ownership")
            profile = profile_from_volume(volume, declared_backend)
            directory = root / "data/volumes" / volume["id"]
            metadata_path = directory / "metadata.json"
            raw = directory / "data.raw"
            assert_no_symlink_components(directory)
            assert_no_symlink_components(metadata_path)
            assert_no_symlink_components(raw)
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
            record = {
                "profile": profile,
                "backend": declared_backend,
                "volume": volume,
                "metadata": metadata,
                "metadataBytes": metadata_path.read_bytes(),
                "raw": raw,
                "attachedTo": attached,
            }
            if declared_backend == backend:
                profiles.append(record)
            else:
                foreign_profiles.append(record)
            if attached and declared_backend == backend:
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
    all_profiles = sorted(profiles + foreign_profiles, key=lambda row: row["profile"])
    for left, right in zip(all_profiles, all_profiles[1:]):
        if left["profile"] == right["profile"]:
            findings.append(
                {
                    "severity": "error",
                    "code": "duplicate_profile_volume",
                    "profile": left["profile"],
                    "detail": "more than one owned volume across backends has this logical profile name",
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
    age = None
    zstd = None
    try:
        with temporary.open("xb") as output:
            os.chmod(temporary, 0o600)
            if unencrypted:
                compressed_output = output
            else:
                age = subprocess.Popen(
                    age_command_for(recipients),
                    stdin=subprocess.PIPE,
                    stdout=output,
                    stderr=subprocess.PIPE,
                )
                compressed_output = age.stdin
            zstd = subprocess.Popen(
                [zstd_command, "-q", "-T2", "-3", "--check", "-c"],
                stdin=subprocess.PIPE,
                stdout=compressed_output,
                stderr=subprocess.PIPE,
            )
            if age:
                age.stdin.close()
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
            zstd_stderr = zstd.stderr.read()
            zstd_code = zstd.wait()
            age_stderr = age.stderr.read() if age else b""
            age_code = age.wait() if age else 0
            zstd.stderr.close()
            if age:
                age.stderr.close()
            if zstd_code or age_code:
                raise RuntimeError(
                    "profile image compression or encryption failed: "
                    + (zstd_stderr + age_stderr).decode(errors="replace")[-300:]
                )
            output.flush()
            os.fsync(output.fileno())
        raw_hash = digest.hexdigest()
        if unencrypted:
            verify_compressed(zstd_command, temporary, raw_hash, size)
        return raw_hash, size
    except BaseException:
        for process in (zstd, age):
            if process and process.poll() is None:
                process.kill()
            if process:
                process.wait()
        if zstd and zstd.stderr:
            zstd.stderr.close()
        if age and age.stderr:
            age.stderr.close()
        temporary.unlink(missing_ok=True)
        raise


def age_command_for(recipients):
    command = [executable("age", "AGENTBROWSE_AGE")]
    for recipient in recipients:
        command += ["-r", recipient]
    return command


def validate_encryption(recipients, unencrypted):
    executable("zstd", "AGENTBROWSE_ZSTD")
    if unencrypted:
        return
    if not recipients:
        raise RuntimeError(
            "authenticated encryption is the default; pass at least one age --recipient "
            "(or explicitly acknowledge plaintext with --unencrypted)"
        )
    result = subprocess.run(
        age_command_for(sorted(set(recipients))),
        input=b"",
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    if result.returncode:
        raise RuntimeError("age recipient validation failed: " + result.stderr.decode()[-300:])


def publish_manifest(path, manifest, recipients, unencrypted):
    encoded = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise RuntimeError("backup manifest exceeds its safe size limit")
    if unencrypted:
        write_private_bytes(path / "manifest.json", encoded)
        return path / "manifest.json"
    temporary = path / (".manifest.%s.tmp" % uuid.uuid4().hex)
    try:
        result = subprocess.run(
            age_command_for(recipients), input=encoded, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        if result.returncode:
            raise RuntimeError("backup manifest encryption failed: " + result.stderr.decode()[-300:])
        write_private_bytes(temporary, result.stdout)
        temporary.replace(path / "manifest.json.age")
        directory = os.open(path, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return path / "manifest.json.age"
    finally:
        temporary.unlink(missing_ok=True)


def backup(api, root, backend, destination, recipients, unencrypted, dry_run):
    if not destination.is_absolute():
        raise RuntimeError("backup set path must be absolute")
    assert_no_symlink_components(destination, allow_missing=True)
    recipients = sorted(set(recipients))
    validate_encryption(recipients, unencrypted)
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
    existed = destination.exists()
    if existed:
        if not destination.is_dir():
            raise RuntimeError("backup destination is not a directory")
        existing_names = {child.name for child in destination.iterdir()}
        if existing_names and "backup-state.json" not in existing_names:
            raise RuntimeError("refusing nonempty backup destination without an owned state receipt")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(destination, 0o700)
    lock_name = ".agentbrowse-backup-%s.lock" % hashlib.sha256(str(destination).encode()).hexdigest()
    with operation_lock(destination.parent / lock_name):
        assert_no_symlink_components(destination)
        inventory = [source_record(row, backend) for row in profiles]
        requested = {
            "format": FORMAT,
            "version": 2,
            "stateKind": "private-backup-operation",
            "backendSha256": hashlib.sha256(backend.encode()).hexdigest(),
            "inventorySha256": value_digest(inventory),
            "encryption": {
                "method": "none-explicit" if unencrypted else "age-x25519",
                "recipientSha256": []
                if unencrypted
                else [hashlib.sha256(value.encode()).hexdigest() for value in recipients],
            },
        }
        state_path = destination / "backup-state.json"
        assert_no_symlink_components(state_path, allow_missing=True)
        if not state_path.exists() and any(destination.iterdir()):
            raise RuntimeError("refusing nonempty backup destination without an owned state receipt")
        if state_path.exists():
            details = state_path.stat()
            if (
                not state_path.is_file()
                or details.st_uid != os.geteuid()
                or stat.S_IMODE(details.st_mode) & 0o077
            ):
                raise RuntimeError("backup destination state receipt is not private and owned")
        state = json.loads(state_path.read_text()) if state_path.exists() else requested
        allowed_state_keys = set(requested) | {"manifestSha256", "setDigest"}
        if set(state) - allowed_state_keys:
            raise RuntimeError("backup destination state receipt has unexpected fields")
        if any(state.get(key) != requested[key] for key in requested):
            raise RuntimeError("backup resume used different source or encryption options")
        if state_path.exists() and state.get("stateKind") != "private-backup-operation":
            raise RuntimeError("backup destination state receipt is not AgentBrowse-owned")
        if not state_path.exists():
            write_private(api, state_path, state)
        manifest_path = destination / ("manifest.json" if unencrypted else "manifest.json.age")
        other_manifest = destination / ("manifest.json.age" if unencrypted else "manifest.json")
        if other_manifest.exists():
            raise RuntimeError("backup set publication conflicts with requested encryption")
        if manifest_path.exists():
            actual_manifest_hash = sha256_file(manifest_path)[0]
            if state.get("manifestSha256") not in (None, actual_manifest_hash):
                raise RuntimeError("published backup manifest changed")
            for index, row in enumerate(profiles):
                before = assert_clean_detached(api, root, row)
                receipt = destination / "profiles" / ("%06d" % index) / "resume.json"
                assert_no_symlink_components(receipt)
                resume = json.loads(receipt.read_text())
                expected_source = source_record(row, backend, before)
                if (
                    not receipt.is_file()
                    or resume.get("sourceSha256") != value_digest(expected_source)
                    or row["metadataBytes"]
                    != (root / "data/volumes" / row["volume"]["id"] / "metadata.json").read_bytes()
                ):
                    raise RuntimeError("completed backup set no longer matches its source volume")
                entry = {
                    "version": 1,
                    "profile": row["profile"],
                    "source": expected_source,
                    "filesystem": {"type": "ext4", "check": "e2fsck-fn-clean"},
                    "archive": resume["archive"],
                }
                validate_entry_path(destination, entry)
            if state.get("manifestSha256") is None:
                state["manifestSha256"] = actual_manifest_hash
                write_private(api, state_path, state)
            if not re.fullmatch(r"[0-9a-f]{64}", str(state.get("setDigest", ""))):
                raise RuntimeError("completed backup state lacks its retained set digest")
            return {
                **plan,
                "complete": True,
                "resumed": True,
                "setDigest": state["setDigest"],
            }
        profiles_directory = destination / "profiles"
        profiles_directory.mkdir(mode=0o700, exist_ok=True)
        assert_no_symlink_components(profiles_directory)
        entries = []
        for index, row in enumerate(profiles):
            before = assert_clean_detached(api, root, row)
            directory = profiles_directory / ("%06d" % index)
            directory.mkdir(mode=0o700, exist_ok=True)
            assert_no_symlink_components(directory)
            archive_name = "data.raw.zst" + ("" if unencrypted else ".age")
            archive = directory / archive_name
            receipt = directory / "resume.json"
            assert_no_symlink_components(receipt, allow_missing=True)
            expected_source = source_record(row, backend, before)
            if receipt.exists():
                resume = json.loads(receipt.read_text())
                assert_no_symlink_components(archive)
                if (
                    resume.get("sourceSha256") != value_digest(expected_source)
                    or resume.get("archive", {}).get("encryption") != requested["encryption"]["method"]
                    or not archive.is_file()
                ):
                    raise RuntimeError("backup resume receipt conflicts with current source or encryption")
                stored_hash, stored_size = sha256_file(archive)
                if (stored_hash, stored_size) != (resume["archive"]["sha256"], resume["archive"]["bytes"]):
                    raise RuntimeError("backup archive changed after publication")
                if (
                    row["metadataBytes"]
                    != (root / "data/volumes" / row["volume"]["id"] / "metadata.json").read_bytes()
                    or not detached(api, root, row["volume"]["id"])
                ):
                    raise RuntimeError("profile changed or became attached during backup resume")
                entries.append(
                    {
                        "version": 1,
                        "profile": row["profile"],
                        "source": expected_source,
                        "filesystem": {"type": "ext4", "check": "e2fsck-fn-clean"},
                        "archive": resume["archive"],
                    }
                )
                continue
            temporary = directory / (archive_name + ".partial")
            compressed_temporary = temporary.with_name(temporary.name + ".zstd")
            for stale in (temporary, compressed_temporary, archive):
                if stale.is_symlink() or (stale.exists() and not stale.is_file()):
                    raise RuntimeError("unsafe backup staging path")
                stale.unlink(missing_ok=True)
            try:
                raw_hash, raw_size = start_archive(row["raw"], temporary, recipients, unencrypted)
                if (
                    fingerprint(row["raw"]) != before
                    or row["metadataBytes"]
                    != (root / "data/volumes" / row["volume"]["id"] / "metadata.json").read_bytes()
                    or not detached(api, root, row["volume"]["id"])
                ):
                    raise RuntimeError("profile changed or became attached during backup")
                temporary.replace(archive)
            finally:
                temporary.unlink(missing_ok=True)
                compressed_temporary.unlink(missing_ok=True)
            stored_hash, stored_size = sha256_file(archive)
            archive_record = {
                "path": "profiles/%06d/%s" % (index, archive_name),
                "bytes": stored_size, "sha256": stored_hash, "rawBytes": raw_size,
                "rawSha256": raw_hash, "compression": "zstd-level-3",
                "encryption": requested["encryption"]["method"],
            }
            entry = {
                "version": 1, "profile": row["profile"], "source": expected_source,
                "filesystem": {"type": "ext4", "check": "e2fsck-fn-clean"},
                "archive": archive_record,
            }
            write_private(
                api,
                receipt,
                {"version": 1, "sourceSha256": value_digest(expected_source), "archive": archive_record},
            )
            entries.append(entry)
        manifest = {
            "format": FORMAT, "version": FORMAT_VERSION,
            "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source": {"backend": backend, "platform": platform.system().lower(),
                       "hypeman": "0.3.0", "profileSchema": PROFILE_SCHEMA_VERSION},
            "encryption": requested["encryption"], "profiles": entries,
        }
        # Publication point: only the complete authoritative manifest is renamed into place.
        state["setDigest"] = manifest_digest(manifest)
        write_private(api, state_path, state)
        published = publish_manifest(destination, manifest, recipients, unencrypted)
        state["manifestSha256"] = sha256_file(published)[0]
        write_private(api, state_path, state)
        return {**plan, "complete": True, "resumed": False, "setDigest": state["setDigest"]}


def validate_entry_path(root, entry):
    profile = entry.get("profile", "")
    if not PROFILE.fullmatch(profile):
        raise RuntimeError("backup entry has an invalid logical profile name")
    archive_name = (
        "data.raw.zst.age"
        if entry.get("archive", {}).get("encryption") == "age-x25519"
        else "data.raw.zst"
    )
    expected = entry.get("archive", {}).get("path", "")
    if not re.fullmatch(r"profiles/[0-9]{6}/" + re.escape(archive_name), str(expected)):
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
        or volume["sizeGiB"] > MAX_VOLUME_GIB
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
    assert_no_symlink_components(path)
    if not path.is_file():
        raise RuntimeError("backup archive is missing or unsafe")
    digest, size = sha256_file(path)
    if digest != entry["archive"].get("sha256") or size != entry["archive"].get("bytes"):
        raise RuntimeError("backup archive integrity check failed")
    return path


def decrypt_manifest(path, identity):
    if not identity:
        raise RuntimeError("encrypted backup inspection or restore requires an age --identity file")
    identity_path = Path(identity)
    if not identity_path.is_absolute():
        raise RuntimeError("age identity path must be absolute on the host")
    assert_no_symlink_components(identity_path)
    if not identity_path.is_file():
        raise RuntimeError("age identity must be a regular file")
    process = subprocess.Popen(
        [executable("age", "AGENTBROWSE_AGE"), "-d", "-i", str(identity_path), str(path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    output = process.stdout.read(MAX_MANIFEST_BYTES + 1)
    if len(output) > MAX_MANIFEST_BYTES:
        process.kill()
        process.wait()
        process.stdout.close()
        process.stderr.close()
        raise RuntimeError("decrypted backup manifest exceeds its safe size limit")
    stderr = process.stderr.read()
    code = process.wait()
    process.stdout.close()
    process.stderr.close()
    if code:
        raise RuntimeError("backup manifest authentication failed: " + stderr.decode()[-300:])
    return output


def manifest_digest(manifest):
    value = dict(manifest)
    value.pop("setDigest", None)
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def inspect_set(path, identity=None, allow_unencrypted=False, expected_set_digest=None):
    if not path.is_absolute():
        raise RuntimeError("backup set path must be absolute")
    assert_no_symlink_components(path)
    encrypted = path / "manifest.json.age"
    plaintext = path / "manifest.json"
    if encrypted.exists() and plaintext.exists():
        raise RuntimeError("backup set has conflicting publication manifests")
    if encrypted.exists():
        assert_no_symlink_components(encrypted)
        encoded = decrypt_manifest(encrypted, identity)
    elif plaintext.exists():
        if not allow_unencrypted:
            raise RuntimeError("plaintext backup restore requires explicit --allow-unencrypted")
        assert_no_symlink_components(plaintext)
        if plaintext.stat().st_size > MAX_MANIFEST_BYTES:
            raise RuntimeError("backup manifest exceeds its safe size limit")
        encoded = plaintext.read_bytes()
    else:
        raise RuntimeError("backup set is incomplete: authoritative manifest is absent")
    manifest = json.loads(encoded)
    if manifest.get("format") != FORMAT or manifest.get("version") != FORMAT_VERSION:
        raise RuntimeError("unsupported backup set format")
    profiles = manifest.get("profiles")
    if not isinstance(profiles, list):
        raise RuntimeError("backup manifest profiles are invalid")
    names = []
    for index, entry in enumerate(profiles):
        if not isinstance(entry, dict) or entry.get("version") != 1:
            raise RuntimeError("backup manifest entry is invalid")
        validate_entry_path(path, entry)
        if entry["archive"]["encryption"] != manifest.get("encryption", {}).get("method"):
            raise RuntimeError("backup manifest encryption metadata disagrees with an entry")
        if not entry["archive"]["path"].startswith("profiles/%06d/" % index):
            raise RuntimeError("backup manifest archive order is invalid")
        names.append(entry["profile"])
    if names != sorted(set(names)):
        raise RuntimeError("backup manifest profile order or uniqueness is invalid")
    expected_method = "age-x25519" if encrypted.exists() else "none-explicit"
    if manifest.get("encryption", {}).get("method") != expected_method:
        raise RuntimeError("authenticated manifest encryption policy is invalid")
    manifest["setDigest"] = manifest_digest(manifest)
    if expected_set_digest and manifest["setDigest"] != expected_set_digest:
        raise RuntimeError("backup manifest does not match the externally retained set digest")
    return manifest


def list_sets(destination, identity=None, allow_unencrypted=False):
    if not destination.is_absolute():
        raise RuntimeError("backup collection must be absolute")
    assert_no_symlink_components(destination)
    if not destination.is_dir():
        raise RuntimeError("backup collection must be a directory")
    sets = []
    for child in sorted(destination.iterdir()):
        if child.is_symlink() or not child.is_dir() or not (
            (child / "manifest.json").is_file() or (child / "manifest.json.age").is_file()
        ):
            continue
        if (child / "manifest.json.age").is_file() and not identity:
            sets.append(
                {
                    "path": str(child),
                    "createdAt": None,
                    "sourceBackend": None,
                    "profileCount": None,
                    "encryption": "age-x25519",
                    "locked": True,
                }
            )
            continue
        manifest = inspect_set(child, identity, allow_unencrypted)
        sets.append(
            {
                "path": str(child),
                "createdAt": manifest["createdAt"],
                "sourceBackend": manifest["source"]["backend"],
                "profileCount": len(manifest["profiles"]),
                "encryption": manifest["encryption"]["method"],
                "locked": False,
            }
        )
    return {"sets": sets, "count": len(sets)}


def write_sparse_extent(stream, extent):
    if not any(extent):
        stream.seek(len(extent), os.SEEK_CUR)
    else:
        stream.write(extent)


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
            stderr=subprocess.PIPE,
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
        stderr=subprocess.PIPE,
    )
    compressed.close()
    digest = hashlib.sha256()
    size = 0
    expected_size = entry["archive"]["rawBytes"]
    try:
        with output.open("xb") as stream:
            os.chmod(output, 0o600)
            pending = bytearray()
            while True:
                block = zstd.stdout.read(CHUNK_BYTES)
                if not block:
                    break
                if size + len(block) > expected_size:
                    zstd.kill()
                    if age:
                        age.kill()
                    raise RuntimeError("decompressed profile image exceeds its recorded size")
                pending.extend(block)
                complete = len(pending) // SPARSE_BLOCK_BYTES * SPARSE_BLOCK_BYTES
                for offset in range(0, complete, SPARSE_BLOCK_BYTES):
                    extent = pending[offset : offset + SPARSE_BLOCK_BYTES]
                    write_sparse_extent(stream, extent)
                del pending[:complete]
                digest.update(block)
                size += len(block)
            if pending:
                write_sparse_extent(stream, pending)
            stream.truncate(size)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        if zstd.poll() is None:
            zstd.kill()
        zstd.wait()
        if age and age.poll() is None:
            age.kill()
        if age:
            age.wait()
            age.stderr.close()
        zstd.stderr.close()
        output.unlink(missing_ok=True)
        raise
    finally:
        zstd.stdout.close()
    zstd_code = zstd.wait()
    age_code = age.wait() if age else 0
    zstd_stderr = zstd.stderr.read()
    age_stderr = age.stderr.read() if age else b""
    zstd.stderr.close()
    if age:
        age.stderr.close()
    if zstd_code or age_code:
        raise RuntimeError(
            "backup decryption or decompression failed: "
            + (zstd_stderr + age_stderr).decode(errors="replace")[-300:]
        )
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


def staging_tags(profile, backend, set_digest):
    return {
        "dev.agentbrowse.managed": "true",
        "dev.agentbrowse.backend": backend,
        "dev.agentbrowse.role": "profile-restore-staging",
        "dev.agentbrowse.restore.profile": profile,
        "dev.agentbrowse.restore.set": set_digest,
    }


def staging_name(profile, set_digest):
    suffix = hashlib.sha256((set_digest + "\0" + profile).encode()).hexdigest()[:24]
    return "agentbrowse-restore-" + suffix


def restore(api, root, backend, source, identity, allow_unencrypted, dry_run,
            expected_set_digest=None, release=False):
    assert_no_symlink_components(root)
    if dry_run:
        return restore_locked(api, root, backend, source, identity, allow_unencrypted,
                              True, expected_set_digest, False)
    with operation_lock(root / "profile-restores" / ".restore.lock"):
        return restore_locked(api, root, backend, source, identity, allow_unencrypted,
                              dry_run, expected_set_digest, release)


def restore_locked(api, root, backend, source, identity, allow_unencrypted, dry_run,
                   expected_set_digest, release):
    if not expected_set_digest:
        raise RuntimeError("restore requires an externally retained --expected-set-digest")
    manifest = inspect_set(source, identity, allow_unencrypted, expected_set_digest)
    set_digest = manifest["setDigest"]
    if expected_set_digest and expected_set_digest != set_digest:
        raise RuntimeError("backup set changed after logical profile reservation")
    executable("zstd", "AGENTBROWSE_ZSTD")
    e2fsck_path()
    api["owned"](root)
    volumes = api["request"](root, "GET", "/volumes")
    instances = api["request"](root, "GET", "/instances")
    attached = {m.get("volume_id") for i in instances for m in i.get("volumes", [])}
    by_name = {volume["name"]: volume for volume in volumes}
    if len(by_name) != len(volumes):
        raise RuntimeError("destination contains duplicate Hypeman volume names")
    receipts = root / "profile-restores" / set_digest
    if release:
        released = []
        for entry in manifest["profiles"]:
            profile = entry["profile"]
            receipt_path = receipts / (profile + ".json")
            assert_no_symlink_components(receipt_path, allow_missing=True)
            if not receipt_path.exists():
                volume = by_name.get(staging_name(profile, set_digest))
                if volume is not None:
                    if (
                        volume.get("tags") != staging_tags(profile, backend, set_digest)
                        or volume["id"] in attached
                        or not detached(api, root, volume["id"])
                    ):
                        raise RuntimeError("restore staging ownership changed: " + profile)
                    api["request"](root, "DELETE", "/volumes/" + volume["id"])
                released.append(profile)
                continue
            saved = json.loads(receipt_path.read_text())
            if (
                saved.get("version") != 1
                or saved.get("profile") != profile
                or saved.get("setDigest") != set_digest
                or not VOLUME_ID.fullmatch(str(saved.get("volumeId", "")))
            ):
                raise RuntimeError("restore receipt conflicts with this backup set")
            if saved.get("complete"):
                raise RuntimeError("cannot release a completed restore: " + profile)
            volume = next((v for v in volumes if v.get("id") == saved.get("volumeId")), None)
            if volume:
                if (
                    volume.get("tags") != staging_tags(profile, backend, set_digest)
                    or volume["id"] in attached
                    or not detached(api, root, volume["id"])
                ):
                    raise RuntimeError("restore staging ownership changed: " + profile)
                api["request"](root, "DELETE", "/volumes/" + volume["id"])
            receipt_path.unlink()
            released.append(profile)
        return {"released": released, "setDigest": set_digest, "dryRun": False}
    plans = []
    for entry in manifest["profiles"]:
        profile = entry["profile"]
        name = "agentbrowse-profile-" + profile
        if name in by_name:
            receipt_path = receipts / (profile + ".json")
            assert_no_symlink_components(receipt_path, allow_missing=True)
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
            candidate = by_name.get(staging_name(profile, set_digest))
            if candidate is not None:
                if candidate.get("tags") != staging_tags(profile, backend, set_digest):
                    raise RuntimeError("deterministic restore staging name is foreign: " + profile)
                action = "resume-staging-volume"
            else:
                action = "create-fresh-volume"
        plans.append({"profile": profile, "name": name, "action": action})
    result = {
        "source": str(source),
        "sourceBackend": manifest["source"]["backend"],
        "destinationBackend": backend,
        "profiles": plans,
        "dryRun": dry_run,
        "setDigest": set_digest,
    }
    if dry_run:
        with tempfile.TemporaryDirectory(prefix="agentbrowse-restore-validation-") as temporary:
            temporary = Path(temporary)
            for index, entry in enumerate(manifest["profiles"]):
                output = temporary / ("%06d.raw" % index)
                extract_archive(validate_entry_path(source, entry), output, entry, identity)
                check_filesystem(output)
        return result
    receipts.mkdir(parents=True, exist_ok=True, mode=0o700)
    completed = []
    for entry in manifest["profiles"]:
        profile = entry["profile"]
        receipt_path = receipts / (profile + ".json")
        assert_no_symlink_components(receipt_path, allow_missing=True)
        saved = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
        if saved and saved.get("complete"):
            directory = root / "data/volumes" / saved["volumeId"]
            metadata_path = directory / "metadata.json"
            raw = directory / "data.raw"
            assert_no_symlink_components(directory)
            assert_no_symlink_components(metadata_path)
            assert_no_symlink_components(raw)
            metadata = json.loads(metadata_path.read_text())
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
            published_after_interruption = (
                by_name.get("agentbrowse-profile-" + profile, {}).get("id") == volume.get("id")
                and volume.get("tags") == destination_tags(profile, backend)
            )
            if (
                volume.get("tags") != staging_tags(profile, backend, set_digest)
                and not published_after_interruption
            ):
                raise RuntimeError("restore staging ownership changed: " + profile)
        else:
            volume_name = staging_name(profile, set_digest)
            tags = staging_tags(profile, backend, set_digest)
            volume = by_name.get(volume_name)
            if volume is not None and volume.get("tags") != tags:
                raise RuntimeError("deterministic restore staging name is foreign: " + profile)
            if volume is None:
                volume = api["request"](
                    root,
                    "POST",
                    "/volumes",
                    {
                        "name": volume_name,
                        "size_gb": entry["source"]["volume"]["sizeGiB"],
                        "tags": tags,
                    },
                )
                volumes.append(volume)
                by_name[volume_name] = volume
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
        assert_no_symlink_components(directory)
        assert_no_symlink_components(raw)
        assert_no_symlink_components(staging, allow_missing=True)
        raw_hash, raw_size = sha256_file(raw)
        expected_hash = entry["archive"]["rawSha256"]
        expected_size = entry["archive"]["rawBytes"]
        if (raw_hash, raw_size) != (expected_hash, expected_size):
            if staging.exists():
                if not staging.is_file():
                    raise RuntimeError("unsafe restore staging path")
                staging.unlink()
            try:
                extract_archive(validate_entry_path(source, entry), staging, entry, identity)
                check_filesystem(staging)
                staging.replace(raw)
            finally:
                staging.unlink(missing_ok=True)
        if sha256_file(raw) != (expected_hash, expected_size):
            raise RuntimeError("installed restore image failed its final digest check")
        check_filesystem(raw)
        metadata_path = directory / "metadata.json"
        assert_no_symlink_components(metadata_path)
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
    listing.add_argument("--identity")
    listing.add_argument("--allow-unencrypted", action="store_true")
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--set", dest="backup_set", type=Path, required=True)
    inspect.add_argument("--identity")
    inspect.add_argument("--allow-unencrypted", action="store_true")
    inspect.add_argument("--expected-set-digest")
    restore_parser = commands.add_parser("restore")
    restore_parser.add_argument("--set", dest="backup_set", type=Path, required=True)
    restore_parser.add_argument("--identity")
    restore_parser.add_argument("--allow-unencrypted", action="store_true")
    restore_parser.add_argument("--expected-set-digest", required=True)
    restore_parser.add_argument("--release", action="store_true")
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
        output = list_sets(args.destination, args.identity, args.allow_unencrypted)
    elif args.command == "inspect":
        output = inspect_set(
            args.backup_set,
            args.identity,
            args.allow_unencrypted,
            args.expected_set_digest,
        )
    else:
        output = restore(
            api, args.root, args.backend, args.backup_set, args.identity,
            args.allow_unencrypted, args.dry_run, args.expected_set_digest, args.release
        )
    print(json.dumps(output, sort_keys=True), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        print("AgentBrowse profile backup: " + str(error), file=sys.stderr)
        sys.exit(1)
