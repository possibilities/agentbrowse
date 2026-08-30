import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type OpenTuiCarry, readOpenTuiCarry } from "../config/opentui-carry.ts";

const root = join(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lockfile = readFileSync(join(root, "bun.lock"), "utf8");
const carry: OpenTuiCarry = readOpenTuiCarry(root);

test("OpenTUI carry source, release, overrides, and lock stay aligned for every package", () => {
  const expectedReleaseBase = `${carry.source.repository}/releases`;

  expect(carry.schemaVersion).toBe(2);
  expect(carry.source.branch).toMatch(/^carry\//);
  expect(carry.source.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(carry.source.baseCarryCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(carry.source.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(carry.release.url).toBe(`${expectedReleaseBase}/tag/${carry.release.tag}`);
  expect(carry.packages.map((entry) => entry.name)).toEqual([
    "@opentui/core",
    "@opentui/core-darwin-arm64",
  ]);
  expect(packageJson.devDependencies["@opentui/core"]).toBe(carry.source.upstreamVersion);

  for (const entry of carry.packages) {
    const { asset } = entry;
    expect(entry.version).toBe(carry.source.upstreamVersion);
    expect(asset.url).toBe(`${expectedReleaseBase}/download/${carry.release.tag}/${asset.name}`);
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(asset.bunIntegrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
    expect(packageJson.overrides[entry.name]).toBe(asset.url);
    expect(lockfile).toContain(`"${entry.name}": "${asset.url}"`);
    expect(lockfile).toContain(`"${entry.name}@${asset.url}"`);
    expect(lockfile).toContain(`"${asset.bunIntegrity}"`);
  }
});

test("the installed OpenTUI native library is the carried build", () => {
  const native = carry.packages.find((entry) => entry.nativeLibrary);
  expect(native?.nativeLibrary).toBeDefined();
  if (!native?.nativeLibrary) return;
  expect(native.nativeLibrary.sha256).toMatch(/^[0-9a-f]{64}$/);

  const packagePath = fileURLToPath(import.meta.resolve(`${native.name}/package.json`));
  const libraryPath = join(dirname(packagePath), native.nativeLibrary.file);
  const digest = createHash("sha256").update(readFileSync(libraryPath)).digest("hex");
  expect(digest).toBe(native.nativeLibrary.sha256);
});
