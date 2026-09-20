import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type AgentbrowseConfig,
  type HypemanBackendConfig,
  loadAgentbrowseConfig,
} from "../config/deployment.ts";
import { CliError } from "./errors.ts";
import { ProfileBindingStore } from "./profile-binding.ts";
import {
  applyRestoreBindingReconciliation,
  completeRestoreBindingReconciliation,
  loadRestoreBindingReconciliation,
  planRestoreBindingReconciliation,
  type RestoreBindingReconciliationPlan,
  releaseRestoreBindingReconciliation,
} from "./restore-reconciliation.ts";
import { runtimeDir, stateDir } from "./runtime.ts";
import { withProviderSessionProfileExclusion } from "./sessions.ts";

export type ParsedBackup =
  | {
      command: "backup";
      action: "measure";
      all: true;
      compressionEstimate: boolean;
      json: boolean;
    }
  | {
      command: "backup";
      action: "create";
      backend: string;
      destination: string;
      recipients: readonly string[];
      unencrypted: boolean;
      dryRun: boolean;
      json: boolean;
    }
  | {
      command: "backup";
      action: "list";
      backend: string;
      destination: string;
      identity?: string;
      allowUnencrypted: boolean;
      json: boolean;
    }
  | {
      command: "backup";
      action: "inspect";
      backend: string;
      set: string;
      identity?: string;
      allowUnencrypted: boolean;
      expectedSetDigest?: string;
      json: boolean;
    }
  | {
      command: "backup";
      action: "restore";
      backend: string;
      set: string;
      identity?: string;
      allowUnencrypted: boolean;
      expectedSetDigest: string;
      releaseReservations: boolean;
      reconcileFromBackend?: string;
      expectedReconciliationDigest?: string;
      bindingStateDirs?: readonly string[];
      dryRun: boolean;
      json: boolean;
    };

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type BackupProcess = (command: readonly string[]) => Promise<ProcessResult>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function defaultProcess(command: readonly string[]): Promise<ProcessResult> {
  const child = Bun.spawn([...command], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export function backupHostCommand(
  backend: HypemanBackendConfig,
  arguments_: readonly string[],
): string[] {
  if (backend.remoteHost === null) {
    const root = dirname(backend.tokenFile);
    return [
      "python3",
      resolve(root, "host/profile-backup.py"),
      "--root",
      root,
      "--helper",
      resolve(root, "host/agentbrowse-hypeman"),
      "--backend",
      backend.id,
      ...arguments_,
    ];
  }
  const remoteCommand = [
    "sudo",
    "-n",
    "python3",
    "/usr/local/lib/agentbrowse/profile-backup.py",
    "--root",
    "/var/lib/agentbrowse-hypeman",
    "--helper",
    "/usr/local/lib/agentbrowse/agentbrowse-hypeman",
    "--backend",
    backend.id,
    ...arguments_,
  ]
    .map(shellQuote)
    .join(" ");
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    backend.remoteHost,
    remoteCommand,
  ];
}

function backend(config: AgentbrowseConfig, id: string): HypemanBackendConfig {
  const match = config.backends.find((entry) => entry.id === id);
  if (match === undefined) throw new CliError("unknown_backend", `unknown backend: ${id}`);
  return match;
}

async function invoke(
  backend: HypemanBackendConfig,
  arguments_: readonly string[],
  process: BackupProcess,
): Promise<Record<string, unknown>> {
  const result = await process(backupHostCommand(backend, arguments_));
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `host command exited ${result.exitCode}`;
    throw new CliError(
      "profile_backup_failed",
      `${backend.id}: ${detail}`,
      "inspect the named backend and retry the same idempotent backup command",
    );
  }
  try {
    const value = JSON.parse(result.stdout);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new CliError(
      "profile_backup_failed",
      `${backend.id}: profile backup helper returned invalid JSON`,
    );
  }
}

function unitValue(value: number, base: number, names: readonly string[]): Record<string, number> {
  return Object.fromEntries(names.map((name, index) => [name, value / base ** index]));
}

function fleetTotals(backends: readonly Record<string, unknown>[]): Record<string, unknown> {
  const keys = [
    "reserved",
    "rawLogical",
    "physicalAllocated",
    "expectedCompressed",
    "compressionUncertainty",
  ] as const;
  const bytes = Object.fromEntries(
    keys.map((key) => [
      key,
      backends.reduce((sum, report) => {
        const totals = report.totals as { bytes?: Record<string, unknown> } | undefined;
        const value = totals?.bytes?.[key];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
          throw new CliError(
            "profile_backup_failed",
            "profile backup helper returned invalid measurement totals",
          );
        }
        return sum + value;
      }, 0),
    ]),
  ) as Record<(typeof keys)[number], number>;
  return {
    bytes,
    decimal: Object.fromEntries(
      keys.map((key) => [
        key,
        unitValue(bytes[key], 1000, ["bytes", "kilobytes", "megabytes", "gigabytes"]),
      ]),
    ),
    binary: Object.fromEntries(
      keys.map((key) => [
        key,
        unitValue(bytes[key], 1024, ["bytes", "kibibytes", "mebibytes", "gibibytes"]),
      ]),
    ),
  };
}

async function bindingFindings(
  reports: readonly Record<string, unknown>[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, unknown>[]> {
  const homes = new Map<string, string[]>();
  for (const report of reports) {
    if (typeof report.backend !== "string" || !Array.isArray(report.profiles)) continue;
    for (const row of report.profiles) {
      if (row === null || typeof row !== "object" || typeof row.profile !== "string") continue;
      const existing = homes.get(row.profile) ?? [];
      existing.push(report.backend);
      homes.set(row.profile, existing);
    }
  }
  const findings: Record<string, unknown>[] = [];
  const bindings = new ProfileBindingStore(stateDir(env));
  const directory = join(stateDir(env), "profiles");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") files = [];
    else throw error;
  }
  const bound = new Set<string>();
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    const profile = file.slice(0, -5);
    try {
      const binding = await bindings.read(profile);
      if (binding === undefined) continue;
      bound.add(binding.profile);
      const observed = homes.get(binding.profile) ?? [];
      if (!observed.includes(binding.backend)) {
        findings.push({
          severity: "error",
          code: "binding_volume_missing",
          profile: binding.profile,
          backend: binding.backend,
        });
      }
      if (binding.pendingImport) {
        findings.push({
          severity: "error",
          code: "profile_import_pending",
          profile: binding.profile,
          backend: binding.backend,
        });
      }
      if (binding.pendingRestore) {
        findings.push({
          severity: "error",
          code: "profile_restore_pending",
          profile: binding.profile,
          backend: binding.backend,
          setDigest: binding.pendingRestore,
        });
      }
    } catch (error) {
      findings.push({
        severity: "error",
        code: "binding_reconciliation_failed",
        receipt: file,
        detail: (error as Error).message,
      });
    }
  }
  for (const [profile, observed] of [...homes].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (observed.length > 1) {
      findings.push({
        severity: "error",
        code: "profile_backend_conflict",
        profile,
        backends: observed,
      });
    } else if (!bound.has(profile)) {
      findings.push({
        severity: "warning",
        code: "profile_binding_missing",
        profile,
        backend: observed[0],
      });
    }
  }
  return findings;
}

export async function runBackup(
  parsed: ParsedBackup,
  env: Readonly<Record<string, string | undefined>> = process.env,
  runner: BackupProcess = defaultProcess,
): Promise<Record<string, unknown>> {
  const config = loadAgentbrowseConfig(env);
  if (parsed.action === "measure") {
    if (config.backends.length === 0) {
      throw new CliError("unknown_backend", "no AgentBrowse backends are configured");
    }
    const reports = await Promise.all(
      config.backends.map((entry) =>
        invoke(
          entry,
          ["measure", ...(parsed.compressionEstimate ? ["--compression-estimate"] : [])],
          runner,
        ),
      ),
    );
    const hostFindings = reports.flatMap((report, index) => {
      const values = report.reconciliationFindings;
      if (!Array.isArray(values))
        throw new CliError(
          "profile_backup_failed",
          `${config.backends[index]!.id}: profile backup helper omitted reconciliation findings`,
        );
      return values.map((finding) => ({
        backend: config.backends[index]!.id,
        finding,
      }));
    });
    const findings = [...hostFindings, ...(await bindingFindings(reports, env))];
    const profileCount = reports.reduce((sum, report) => {
      if (typeof report.profileCount !== "number" || !Number.isSafeInteger(report.profileCount)) {
        throw new CliError("profile_backup_failed", "profile backup helper returned invalid count");
      }
      return sum + report.profileCount;
    }, 0);
    return {
      formatVersion: 1,
      all: true,
      profileCount,
      reconciliationFindings: findings,
      totals: fleetTotals(reports),
      compressionEstimate: {
        requested: parsed.compressionEstimate,
        method: parsed.compressionEstimate ? "stratified-zstd-level-3-v1" : null,
        uncertainty: "95% sample interval plus one MiB per profile; ext4 locality may exceed it",
      },
      backends: reports,
    };
  }

  const selected = backend(config, parsed.backend);
  if (parsed.action === "create") {
    return await invoke(
      selected,
      [
        "create",
        "--destination",
        parsed.destination,
        ...parsed.recipients.flatMap((recipient) => ["--recipient", recipient]),
        ...(parsed.unencrypted ? ["--unencrypted"] : []),
        ...(parsed.dryRun ? ["--dry-run"] : []),
      ],
      runner,
    );
  }
  if (parsed.action === "list") {
    return await invoke(
      selected,
      [
        "list",
        "--destination",
        parsed.destination,
        ...(parsed.identity === undefined ? [] : ["--identity", parsed.identity]),
        ...(parsed.allowUnencrypted ? ["--allow-unencrypted"] : []),
      ],
      runner,
    );
  }
  if (parsed.action === "inspect") {
    return await invoke(
      selected,
      [
        "inspect",
        "--set",
        parsed.set,
        ...(parsed.identity === undefined ? [] : ["--identity", parsed.identity]),
        ...(parsed.allowUnencrypted ? ["--allow-unencrypted"] : []),
        ...(parsed.expectedSetDigest === undefined
          ? []
          : ["--expected-set-digest", parsed.expectedSetDigest]),
      ],
      runner,
    );
  }
  const inspect = await invoke(
    selected,
    [
      "inspect",
      "--set",
      parsed.set,
      ...(parsed.identity === undefined ? [] : ["--identity", parsed.identity]),
      ...(parsed.allowUnencrypted ? ["--allow-unencrypted"] : []),
      "--expected-set-digest",
      parsed.expectedSetDigest,
    ],
    runner,
  );
  const setDigest = inspect.setDigest;
  const sourceBackend = inspect.sourceBackend;
  const profileEntries = inspect.profiles;
  if (
    typeof setDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(setDigest) ||
    setDigest !== parsed.expectedSetDigest ||
    !Array.isArray(profileEntries) ||
    !profileEntries.every(
      (entry) => entry !== null && typeof entry === "object" && typeof entry.profile === "string",
    )
  ) {
    throw new CliError("profile_backup_failed", `${selected.id}: invalid inspected backup set`);
  }
  const profiles = profileEntries.map((entry) => (entry as { profile: string }).profile);
  const bindings = new ProfileBindingStore(stateDir(env));
  let reconciliation: RestoreBindingReconciliationPlan | undefined;
  if (parsed.reconcileFromBackend !== undefined) {
    if (sourceBackend !== parsed.reconcileFromBackend)
      throw new CliError(
        "profile_backup_failed",
        `${selected.id}: backup source backend is ${String(sourceBackend)}, not ${parsed.reconcileFromBackend}`,
        "use the exact source backend reported by the authenticated backup manifest",
      );
    reconciliation = parsed.dryRun
      ? await planRestoreBindingReconciliation(
          profiles,
          parsed.reconcileFromBackend,
          selected.id,
          setDigest,
          stateDir(env),
          parsed.bindingStateDirs ?? [],
          runtimeDir(env),
        )
      : parsed.releaseReservations
        ? await loadRestoreBindingReconciliation(
            stateDir(env),
            parsed.bindingStateDirs ?? [],
            runtimeDir(env),
            profiles,
            parsed.reconcileFromBackend,
            selected.id,
            setDigest,
            parsed.expectedReconciliationDigest!,
          )
        : await applyRestoreBindingReconciliation(
            profiles,
            parsed.reconcileFromBackend,
            selected.id,
            setDigest,
            stateDir(env),
            parsed.bindingStateDirs ?? [],
            runtimeDir(env),
            parsed.expectedReconciliationDigest!,
          );
  } else if (!parsed.dryRun)
    await withProviderSessionProfileExclusion(stateDir(env), profiles, async () => {
      await bindings.reserveRestore(profiles, selected.id, setDigest);
    });
  const restoreArguments = [
    "restore",
    "--set",
    parsed.set,
    ...(parsed.identity === undefined ? [] : ["--identity", parsed.identity]),
    ...(parsed.allowUnencrypted ? ["--allow-unencrypted"] : []),
    "--expected-set-digest",
    parsed.expectedSetDigest,
    ...(parsed.releaseReservations ? ["--release"] : []),
    ...(parsed.dryRun ? ["--dry-run"] : []),
  ];
  const invokeRestore = async () => {
    const value = await invoke(selected, restoreArguments, runner);
    if (
      parsed.releaseReservations &&
      (!Array.isArray(value.released) ||
        value.released.length !== profiles.length ||
        value.released.some((name, index) => name !== profiles[index]))
    )
      throw new CliError(
        "profile_backup_failed",
        `${selected.id}: restore helper released an unexpected profile set`,
      );
    return value;
  };
  const result =
    parsed.releaseReservations && reconciliation !== undefined
      ? await releaseRestoreBindingReconciliation(reconciliation, invokeRestore)
      : await invokeRestore();
  if (!parsed.dryRun) {
    if (parsed.releaseReservations) {
      if (reconciliation === undefined)
        await bindings.releaseRestore(profiles, selected.id, setDigest);
      return {
        ...result,
        bindingsReleased: profiles,
        ...(reconciliation === undefined ? {} : { bindingReconciliation: reconciliation }),
      };
    }
    if (
      !Array.isArray(result.complete) ||
      !result.complete.every((name) => typeof name === "string")
    ) {
      throw new CliError(
        "profile_backup_failed",
        `${selected.id}: restore helper omitted its completed logical profiles`,
      );
    }
    const completed = result.complete as string[];
    if (
      completed.length !== profiles.length ||
      completed.some((name, index) => name !== profiles[index])
    )
      throw new CliError(
        "profile_backup_failed",
        `${selected.id}: restore helper completed an unexpected profile set`,
      );
    if (reconciliation !== undefined) await completeRestoreBindingReconciliation(reconciliation);
    else await bindings.completeRestore(profiles, selected.id, setDigest);
    return {
      ...result,
      bindingsCreated: result.complete,
      ...(reconciliation === undefined ? {} : { bindingReconciliation: reconciliation }),
    };
  }
  return {
    ...result,
    ...(reconciliation === undefined ? {} : { bindingReconciliation: reconciliation }),
  };
}
