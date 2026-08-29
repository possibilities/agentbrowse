import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DockerFarmBackend } from "../cli/backend.ts";
import { loadAgentbrowseConfig } from "../config/deployment.ts";
import { KERNEL_HEADFUL_IMAGE_LOCK } from "../config/kernel-headful-image.ts";
import { validateKernelImageLock } from "../config/kernel-image-lock.ts";
import {
  type LockCommand,
  lockFromRegistryIndex,
  updateKernelImageLock,
} from "../tools/update-kernel-image-lock.ts";

const sourceCommit = "57858c774681c646c238043d5cb75a9ff61797c6";
const platformDigest = "sha256:da9ee68cb9d2de0b3c26885ff3bdcf04c944254a36eb127219028ac017ff56f3";
const fixture = readFileSync(
  join(import.meta.dir, "fixtures", "kernel-image-index.json"),
  "utf8",
).trimEnd();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checked-in lock binds the full Kernel commit to the exact amd64 digest", () => {
  expect(KERNEL_HEADFUL_IMAGE_LOCK).toMatchObject({
    kernelSourceCommit: sourceCommit,
    upstreamTag: "57858c7",
    ociIndexDigest: "sha256:036cb0e97e9b836e2da43c50f8e74278b10449f738ed3cd7d7fc52d262303191",
    platform: { os: "linux", architecture: "amd64", digest: platformDigest },
    runtimeReference: `docker.io/onkernel/chromium-headful@${platformDigest}`,
  });
});

test("lock updater selects exactly one linux/amd64 manifest and hashes the raw index", () => {
  const lock = lockFromRegistryIndex(
    sourceCommit,
    fixture,
    new Date("2026-08-29T00:16:00.000Z"),
    "buildx test",
  );

  expect(lock.ociIndexDigest).toBe(
    "sha256:036cb0e97e9b836e2da43c50f8e74278b10449f738ed3cd7d7fc52d262303191",
  );
  expect(lock.platform.digest).toBe(platformDigest);
  expect(lock.runtimeReference).toBe(`docker.io/onkernel/chromium-headful@${platformDigest}`);

  const parsed = JSON.parse(fixture) as { manifests: unknown[] };
  parsed.manifests.push(parsed.manifests[0]);
  expect(() =>
    lockFromRegistryIndex(sourceCommit, JSON.stringify(parsed), new Date(), "buildx test"),
  ).toThrow("exactly one linux/amd64 manifest; found 2");

  const missing = JSON.parse(fixture) as {
    manifests: Array<{ platform: { architecture: string } }>;
  };
  missing.manifests[0]!.platform.architecture = "arm64";
  expect(() =>
    lockFromRegistryIndex(sourceCommit, JSON.stringify(missing), new Date(), "buildx test"),
  ).toThrow("exactly one linux/amd64 manifest; found 0");

  const wrongMediaType = JSON.parse(fixture) as { mediaType: string };
  wrongMediaType.mediaType = "application/vnd.docker.distribution.manifest.list.v2+json";
  expect(() =>
    lockFromRegistryIndex(sourceCommit, JSON.stringify(wrongMediaType), new Date(), "buildx test"),
  ).toThrow("registry response is not an OCI image index");
});

test("ordinary runtime selection never follows a mutable registry tag", async () => {
  const changedDigest = `sha256:${"1".repeat(64)}`;
  const changedIndex = fixture.replace(platformDigest, changedDigest);
  expect(
    lockFromRegistryIndex(sourceCommit, changedIndex, new Date(), "buildx test").platform.digest,
  ).toBe(changedDigest);

  const config = loadAgentbrowseConfig({
    AGENTBROWSE_CONFIG: "/tmp/agentbrowse-lock-test-does-not-exist.json",
    AGENTBROWSE_DOCKER_CONTEXT: "artbird",
  });
  const backend = new DockerFarmBackend(config, {
    command: async () => {
      throw new Error("runtime must not inspect Git or the registry");
    },
  });
  expect(await backend.resolveImage()).toBe(KERNEL_HEADFUL_IMAGE_LOCK.runtimeReference);
  expect(await backend.resolveImage("explicit@sha256:test")).toBe("explicit@sha256:test");
});

test("maintainer update is explicit and writes one validated lock document", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentbrowse-image-lock-"));
  temporaryDirectories.push(directory);
  const outputPath = join(directory, "kernel-headful.lock.json");
  const calls: string[][] = [];
  const command: LockCommand = async (args) => {
    calls.push([...args]);
    if (args.at(-1) === "--raw") return { exitCode: 0, stdout: fixture, stderr: "" };
    return { exitCode: 0, stdout: "buildx test\n", stderr: "" };
  };

  const lock = await updateKernelImageLock(sourceCommit, {
    command,
    now: () => new Date("2026-08-29T00:16:00.000Z"),
    outputPath,
  });

  expect(calls).toEqual([
    [
      "docker",
      "buildx",
      "imagetools",
      "inspect",
      "docker.io/onkernel/chromium-headful:57858c7",
      "--raw",
    ],
    ["docker", "buildx", "version"],
  ]);
  expect(validateKernelImageLock(JSON.parse(readFileSync(outputPath, "utf8")))).toEqual(lock);
});
