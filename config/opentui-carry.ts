import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface OpenTuiCarryAsset {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly bunIntegrity: string;
}

export interface OpenTuiCarryNativeLibrary {
  readonly file: string;
  readonly sha256: string;
}

export interface OpenTuiCarryPackage {
  readonly name: string;
  readonly version: string;
  readonly asset: OpenTuiCarryAsset;
  readonly nativeLibrary?: OpenTuiCarryNativeLibrary;
}

/** The pinned downstream OpenTUI build: one source commit, several packages. */
export interface OpenTuiCarry {
  readonly schemaVersion: 2;
  readonly source: {
    readonly repository: string;
    readonly branch: string;
    readonly commit: string;
    readonly baseCarryCommit: string;
    readonly upstreamVersion: string;
    readonly upstreamCommit: string;
  };
  readonly release: { readonly tag: string; readonly url: string };
  readonly packages: readonly OpenTuiCarryPackage[];
}

export const OPENTUI_CARRY_PATH = ["config", "opentui-carry.json"] as const;

export function readOpenTuiCarry(root: string): OpenTuiCarry {
  const path = join(root, ...OPENTUI_CARRY_PATH);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OpenTuiCarry>;
  if (parsed.schemaVersion !== 2) {
    throw new Error(`${path}: expected schemaVersion 2, found ${String(parsed.schemaVersion)}`);
  }
  if (!Array.isArray(parsed.packages) || parsed.packages.length === 0) {
    throw new Error(`${path}: packages must list every pinned OpenTUI package`);
  }
  return parsed as OpenTuiCarry;
}

/** The package whose native library digest the carry expects to be installed. */
export function openTuiCarryNativeLibrary(
  carry: OpenTuiCarry,
): (OpenTuiCarryNativeLibrary & { readonly packageName: string }) | null {
  const entry = carry.packages.find((candidate) => candidate.nativeLibrary !== undefined);
  if (!entry?.nativeLibrary) return null;
  return { packageName: entry.name, ...entry.nativeLibrary };
}
