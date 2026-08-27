import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface OpenTuiCarry {
  schemaVersion: number;
  package: { name: string; version: string };
  source: {
    repository: string;
    branch: string;
    commit: string;
    upstreamVersion: string;
    upstreamCommit: string;
  };
  release: {
    tag: string;
    url: string;
    asset: { name: string; url: string; sha256: string; bunIntegrity: string };
  };
}

const root = join(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const lockfile = readFileSync(join(root, "bun.lock"), "utf8");
const carry = JSON.parse(
  readFileSync(join(root, "config", "opentui-carry.json"), "utf8"),
) as OpenTuiCarry;

test("OpenTUI carry source, release, override, and lock stay aligned", () => {
  const { asset } = carry.release;
  const expectedReleaseBase = `${carry.source.repository}/releases`;

  expect(carry.schemaVersion).toBe(1);
  expect(carry.source.branch).toMatch(/^carry\//);
  expect(carry.source.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(carry.source.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(carry.package.version).toBe(carry.source.upstreamVersion);
  expect(carry.release.url).toBe(`${expectedReleaseBase}/tag/${carry.release.tag}`);
  expect(asset.url).toBe(`${expectedReleaseBase}/download/${carry.release.tag}/${asset.name}`);
  expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(asset.bunIntegrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);

  expect(packageJson.devDependencies["@opentui/core"]).toBe(carry.source.upstreamVersion);
  expect(packageJson.overrides[carry.package.name]).toBe(asset.url);
  expect(lockfile).toContain(`"${carry.package.name}": "${asset.url}"`);
  expect(lockfile).toContain(`"${carry.package.name}@${asset.url}"`);
  expect(lockfile).toContain(`"${asset.bunIntegrity}"`);
});
