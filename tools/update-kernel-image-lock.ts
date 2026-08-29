#!/usr/bin/env bun

import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KERNEL_IMAGE_REPOSITORY,
  type KernelImageLock,
  validateKernelImageLock,
} from "../config/kernel-image-lock.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type LockCommand = (args: readonly string[]) => Promise<CommandResult>;

export interface UpdateKernelImageLockOptions {
  readonly command?: LockCommand;
  readonly now?: () => Date;
  readonly outputPath?: string;
}

interface RegistryIndex {
  readonly schemaVersion?: unknown;
  readonly mediaType?: unknown;
  readonly manifests?: unknown;
}

interface RegistryManifest {
  readonly digest?: unknown;
  readonly platform?: unknown;
}

const defaultLockPath = fileURLToPath(
  new URL("../config/kernel-headful.lock.json", import.meta.url),
);
const commitPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const ociImageIndexMediaType = "application/vnd.oci.image.index.v1+json";

async function defaultCommand(args: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function lockFromRegistryIndex(
  sourceCommit: string,
  rawIndex: string,
  verifiedAt: Date,
  verificationTool: string,
): KernelImageLock {
  if (!commitPattern.test(sourceCommit)) {
    throw new Error("Kernel source commit must be exactly 40 lowercase hexadecimal characters");
  }
  let parsed: RegistryIndex;
  try {
    parsed = JSON.parse(rawIndex) as RegistryIndex;
  } catch (error) {
    throw new Error(
      `registry returned invalid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (
    parsed.schemaVersion !== 2 ||
    parsed.mediaType !== ociImageIndexMediaType ||
    !Array.isArray(parsed.manifests)
  ) {
    throw new Error("registry response is not an OCI image index");
  }
  const matches = parsed.manifests.filter((entry): entry is RegistryManifest => {
    if (!isObject(entry) || !isObject(entry.platform)) return false;
    return entry.platform.os === "linux" && entry.platform.architecture === "amd64";
  });
  if (matches.length !== 1) {
    throw new Error(
      `registry index must contain exactly one linux/amd64 manifest; found ${matches.length}`,
    );
  }
  const platformDigest = matches[0]!.digest;
  if (typeof platformDigest !== "string" || !digestPattern.test(platformDigest)) {
    throw new Error("linux/amd64 manifest has an invalid digest");
  }
  const indexDigest = `sha256:${new Bun.CryptoHasher("sha256").update(rawIndex).digest("hex")}`;
  const upstreamTag = sourceCommit.slice(0, 7);
  return validateKernelImageLock({
    schemaVersion: 1,
    repository: KERNEL_IMAGE_REPOSITORY,
    kernelSourceCommit: sourceCommit,
    upstreamTag,
    ociIndexDigest: indexDigest,
    platform: { os: "linux", architecture: "amd64", digest: platformDigest },
    runtimeReference: `${KERNEL_IMAGE_REPOSITORY}@${platformDigest}`,
    verifiedAt: verifiedAt.toISOString(),
    verificationTool,
  });
}

export async function updateKernelImageLock(
  sourceCommit: string,
  options: UpdateKernelImageLockOptions = {},
): Promise<KernelImageLock> {
  const command = options.command ?? defaultCommand;
  const upstreamTag = sourceCommit.slice(0, 7);
  if (!commitPattern.test(sourceCommit)) {
    throw new Error("Kernel source commit must be exactly 40 lowercase hexadecimal characters");
  }
  const tagReference = `${KERNEL_IMAGE_REPOSITORY}:${upstreamTag}`;
  const inspection = await command([
    "docker",
    "buildx",
    "imagetools",
    "inspect",
    tagReference,
    "--raw",
  ]);
  if (inspection.exitCode !== 0) throw commandFailure("registry inspection", inspection);
  const version = await command(["docker", "buildx", "version"]);
  if (version.exitCode !== 0) throw commandFailure("Buildx version inspection", version);
  const lock = lockFromRegistryIndex(
    sourceCommit,
    inspection.stdout,
    options.now?.() ?? new Date(),
    version.stdout.trim(),
  );
  writeLockAtomically(options.outputPath ?? defaultLockPath, lock);
  return lock;
}

function writeLockAtomically(path: string, lock: KernelImageLock): void {
  const temporary = join(
    dirname(path),
    `.kernel-headful.lock.${process.pid}.${crypto.randomUUID()}`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function commandFailure(label: string, result: CommandResult): Error {
  return new Error(
    `${label} failed: ${result.stderr.trim() || result.stdout.trim() || result.exitCode}`,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length !== 1 || argv[0] === "-h" || argv[0] === "--help") {
    const destination = argv.length === 1 ? process.stdout : process.stderr;
    destination.write("Usage: tools/update-kernel-image-lock FULL_KERNEL_COMMIT\n");
    return argv.length === 1 ? 0 : 2;
  }
  try {
    const lock = await updateKernelImageLock(argv[0]!);
    process.stdout.write(`${lock.runtimeReference}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`update-kernel-image-lock: ${(error as Error).message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
