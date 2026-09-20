import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { CliError } from "./errors.ts";
import { withRuntimeAllocationLock } from "./farm.ts";
import { configPath, parseTargetConfig, type Target } from "./model.ts";
import {
  type ProfileBinding,
  ProfileBindingStore,
  parseProfileBinding,
} from "./profile-binding.ts";
import {
  assertNoProviderSessionProfiles,
  withProviderSessionProfileExclusions,
} from "./sessions.ts";

export interface RestoreBindingReconciliationPlan {
  readonly version: 1;
  readonly setDigest: string;
  readonly sourceBackend: string;
  readonly destinationBackend: string;
  readonly runtimeDir: string;
  readonly runtimeIdentity: DirectoryIdentity | null;
  readonly namespaces: readonly RestoreBindingNamespacePlan[];
  readonly reconciliationDigest: string;
}

interface RestoreBindingNamespacePlan {
  readonly stateDir: string;
  readonly identity: DirectoryIdentity;
  readonly profiles: readonly RestoreBindingExpectation[];
}

interface DirectoryIdentity {
  readonly device: number;
  readonly inode: number;
}

interface RestoreBindingExpectation {
  readonly profile: string;
  readonly owner: boolean;
  readonly binding: null | {
    readonly sha256: string;
    readonly backend: string;
    readonly target: null | {
      readonly name: string;
      readonly profile: string;
      readonly backend: string;
      readonly container: string;
      readonly slot: number;
      readonly receiptSha256: string | null;
    };
  };
}

interface ReconciliationJournal {
  readonly version: 1;
  readonly plan: RestoreBindingReconciliationPlan;
  readonly status: "prepared" | "reserved" | "released";
  readonly completed: readonly string[];
  readonly releasedNamespaces: readonly string[];
}

interface BindingObservation {
  readonly binding: ProfileBinding;
  readonly sha256: string;
  readonly targetReceiptSha256: string | null;
}

export async function planRestoreBindingReconciliation(
  profiles: readonly string[],
  sourceBackend: string,
  destinationBackend: string,
  setDigest: string,
  primaryStateDir: string,
  additionalStateDirs: readonly string[],
  runtimeDir: string,
): Promise<RestoreBindingReconciliationPlan> {
  const stateDirs = namespacePaths(primaryStateDir, additionalStateDirs);
  await assertNoProviderSessionProfiles(stateDirs, profiles);
  return await buildPlanLocked(
    profiles,
    sourceBackend,
    destinationBackend,
    setDigest,
    stateDirs,
    runtimeDir,
  );
}

export async function applyRestoreBindingReconciliation(
  profiles: readonly string[],
  sourceBackend: string,
  destinationBackend: string,
  setDigest: string,
  primaryStateDir: string,
  additionalStateDirs: readonly string[],
  runtimeDir: string,
  expectedReconciliationDigest: string,
): Promise<RestoreBindingReconciliationPlan> {
  const stateDirs = namespacePaths(primaryStateDir, additionalStateDirs);
  const initialJournal = await readJournal(reconciliationJournalPath(primaryStateDir, setDigest));
  const initialPlan =
    initialJournal === undefined
      ? await buildPlanLocked(
          profiles,
          sourceBackend,
          destinationBackend,
          setDigest,
          stateDirs,
          runtimeDir,
        )
      : undefined;
  if (initialPlan !== undefined) requireExpectedPlan(initialPlan, expectedReconciliationDigest);
  return await withReconciliationLocks(stateDirs, profiles, runtimeDir, async () => {
    const journalPath = reconciliationJournalPath(primaryStateDir, setDigest);
    let journal = await readJournal(journalPath);
    if (journal === undefined) {
      const plan = await buildPlanLocked(
        profiles,
        sourceBackend,
        destinationBackend,
        setDigest,
        stateDirs,
        runtimeDir,
        initialPlan === undefined ? undefined : { runtimeIdentity: initialPlan.runtimeIdentity },
      );
      requireExpectedPlan(plan, expectedReconciliationDigest);
      journal = {
        version: 1,
        plan,
        status: "prepared",
        completed: [],
        releasedNamespaces: [],
      };
      await writeJournal(journalPath, journal);
    } else {
      requireMatchingOperation(
        journal.plan,
        profiles,
        sourceBackend,
        destinationBackend,
        setDigest,
        stateDirs,
        runtimeDir,
      );
      requireExpectedPlan(journal.plan, expectedReconciliationDigest);
      if (journal.status === "released") {
        journal = { ...journal, status: "prepared", completed: [], releasedNamespaces: [] };
        await writeJournal(journalPath, journal);
      }
    }
    await verifyPlanDirectories(journal.plan);

    const completed = new Set(journal.completed);
    for (const namespace of journal.plan.namespaces) {
      const store = new ProfileBindingStore(namespace.stateDir);
      const owners = namespace.profiles.filter((entry) => entry.owner);
      for (const expectation of namespace.profiles) {
        if (!expectation.owner) {
          if ((await store.read(expectation.profile)) !== undefined)
            throw changed(`profile ${expectation.profile} appeared in ${namespace.stateDir}`);
          continue;
        }
        await retireExpectedBinding(
          store,
          namespace.stateDir,
          journal.plan.runtimeDir,
          journal.plan.setDigest,
          journal.plan.destinationBackend,
          expectation,
        );
      }
      if (owners.length > 0)
        await store.reserveRestoreLocked(
          owners.map((entry) => entry.profile),
          journal.plan.destinationBackend,
          journal.plan.setDigest,
        );
      for (const owner of owners) completed.add(owner.profile);
      journal = { ...journal, completed: [...completed].sort() };
      await writeJournal(journalPath, journal);
    }
    journal = { ...journal, status: "reserved" };
    await writeJournal(journalPath, journal);
    return journal.plan;
  });
}

export async function loadRestoreBindingReconciliation(
  primaryStateDir: string,
  additionalStateDirs: readonly string[],
  runtimeDir: string,
  profiles: readonly string[],
  sourceBackend: string,
  destinationBackend: string,
  setDigest: string,
  expectedReconciliationDigest: string,
): Promise<RestoreBindingReconciliationPlan> {
  const journal = await readJournal(reconciliationJournalPath(primaryStateDir, setDigest));
  if (journal === undefined) throw changed("restore binding reconciliation journal is missing");
  requireMatchingOperation(
    journal.plan,
    profiles,
    sourceBackend,
    destinationBackend,
    setDigest,
    namespacePaths(primaryStateDir, additionalStateDirs),
    runtimeDir,
  );
  requireExpectedPlan(journal.plan, expectedReconciliationDigest);
  if (journal.status === "prepared")
    throw changed("restore binding reconciliation did not finish publishing reservations");
  await verifyPlanDirectories(journal.plan);
  return journal.plan;
}

export async function completeRestoreBindingReconciliation(
  plan: RestoreBindingReconciliationPlan,
): Promise<void> {
  await verifyPlanDirectories(plan);
  for (const namespace of plan.namespaces) {
    const profiles = namespace.profiles
      .filter((entry) => entry.owner)
      .map((entry) => entry.profile);
    if (profiles.length === 0) continue;
    await new ProfileBindingStore(namespace.stateDir).completeRestore(
      profiles,
      plan.destinationBackend,
      plan.setDigest,
    );
  }
}

export async function releaseRestoreBindingReconciliation(
  plan: RestoreBindingReconciliationPlan,
): Promise<void> {
  await verifyPlanDirectories(plan);
  const path = reconciliationJournalPath(plan.namespaces[0]!.stateDir, plan.setDigest);
  let journal = await readJournal(path);
  if (journal === undefined || journal.plan.reconciliationDigest !== plan.reconciliationDigest)
    throw changed("restore binding reconciliation journal is missing or changed");
  const released = new Set(journal.releasedNamespaces);
  for (const namespace of plan.namespaces) {
    if (released.has(namespace.stateDir)) continue;
    const profiles = namespace.profiles
      .filter((entry) => entry.owner)
      .map((entry) => entry.profile);
    if (profiles.length === 0) {
      released.add(namespace.stateDir);
      continue;
    }
    await new ProfileBindingStore(namespace.stateDir).releaseRestore(
      profiles,
      plan.destinationBackend,
      plan.setDigest,
    );
    released.add(namespace.stateDir);
    journal = { ...journal, releasedNamespaces: [...released].sort() };
    await writeJournal(path, journal);
  }
  await writeJournal(path, { ...journal, status: "released", completed: [] });
}

async function buildPlanLocked(
  profiles: readonly string[],
  sourceBackend: string,
  destinationBackend: string,
  setDigest: string,
  stateDirs: readonly string[],
  runtimeDir: string,
  options?: { readonly runtimeIdentity: DirectoryIdentity | null },
): Promise<RestoreBindingReconciliationPlan> {
  const names = [...new Set(profiles)].sort();
  const observations = new Map<string, Map<string, BindingObservation>>();
  for (const stateDir of stateDirs) {
    const store = new ProfileBindingStore(stateDir);
    const namespace = new Map<string, BindingObservation>();
    for (const profile of names) {
      const observation = await observeBinding(store, profile, runtimeDir);
      if (observation !== undefined) namespace.set(profile, observation);
    }
    observations.set(stateDir, namespace);
  }

  const owners = new Map<string, string>();
  for (const profile of names) {
    const matches = stateDirs.filter((stateDir) => observations.get(stateDir)!.has(profile));
    if (matches.length > 1)
      throw new CliError(
        "profile_backend_conflict",
        `Browser profile ${profile} has bindings in more than one restore namespace`,
        "remove no receipts; inspect the exact state namespaces and retry with one authoritative binding",
      );
    const owner = matches[0] ?? stateDirs[0]!;
    const observation = observations.get(owner)!.get(profile);
    if (observation !== undefined) {
      if (observation.binding.backend !== sourceBackend)
        throw new CliError(
          "profile_backend_mismatch",
          `Browser profile ${profile} is bound to backend ${observation.binding.backend}, not backup source ${sourceBackend}`,
          "use the exact backup source backend; unrelated bindings are never retired",
        );
      if (
        observation.binding.pendingImport ||
        observation.binding.pendingRestore ||
        observation.binding.restoredFrom
      )
        throw changed(`profile ${profile} is not an ordinary source binding`);
    }
    owners.set(profile, owner);
  }

  const base = {
    version: 1 as const,
    setDigest,
    sourceBackend,
    destinationBackend,
    runtimeDir,
    runtimeIdentity:
      options === undefined ? await optionalDirectoryIdentity(runtimeDir) : options.runtimeIdentity,
    namespaces: await Promise.all(
      stateDirs.map(async (stateDir) => ({
        stateDir,
        identity: await directoryIdentity(stateDir),
        profiles: names.map((profile) => {
          const observation = observations.get(stateDir)!.get(profile);
          return {
            profile,
            owner: owners.get(profile) === stateDir,
            binding:
              observation === undefined
                ? null
                : {
                    sha256: observation.sha256,
                    backend: observation.binding.backend,
                    target:
                      observation.binding.target === null
                        ? null
                        : {
                            name: observation.binding.target.name,
                            profile: observation.binding.target.profile,
                            backend: observation.binding.target.backend,
                            container: observation.binding.target.container,
                            slot: observation.binding.target.slot,
                            receiptSha256: observation.targetReceiptSha256,
                          },
                  },
          };
        }),
      })),
    ),
  };
  return { ...base, reconciliationDigest: digest(JSON.stringify(base)) };
}

async function observeBinding(
  store: ProfileBindingStore,
  profile: string,
  runtimeDir: string,
): Promise<BindingObservation | undefined> {
  const path = store.bindingPath(profile);
  const source = await readRegularFile(path);
  if (source === undefined) return undefined;
  const binding = parseProfileBinding(source);
  if (binding.profile !== profile) throw changed(`binding filename and profile disagree: ${path}`);
  let targetReceiptSha256: string | null = null;
  if (binding.target !== null) {
    const targetPath = configPath(runtimeDir, binding.target.name);
    const targetSource = await readRegularFile(targetPath);
    if (targetSource !== undefined) {
      const target = parseTargetConfig(targetSource);
      requireTarget(target, binding.target, targetPath);
      targetReceiptSha256 = digest(targetSource);
    }
  }
  return { binding, sha256: digest(source), targetReceiptSha256 };
}

async function retireExpectedBinding(
  store: ProfileBindingStore,
  stateDir: string,
  runtimeDir: string,
  setDigest: string,
  destinationBackend: string,
  expectation: RestoreBindingExpectation,
): Promise<void> {
  const current = await store.read(expectation.profile);
  const original = expectation.binding;
  if (original === null) {
    if (
      current !== undefined &&
      !(
        current.backend === destinationBackend &&
        current.target === null &&
        (current.pendingRestore === setDigest || current.restoredFrom === setDigest)
      )
    )
      throw changed(`profile ${expectation.profile} changed after the reconciliation plan`);
    return;
  }

  const bindingPath = store.bindingPath(expectation.profile);
  const archiveRoot = join(stateDir, "retired-bindings", "restore-reconciliations", setDigest);
  const archivedBinding = join(archiveRoot, "profiles", `${expectation.profile}.json`);
  if (
    current !== undefined &&
    current.backend === destinationBackend &&
    current.target === null &&
    (current.pendingRestore === setDigest || current.restoredFrom === setDigest)
  ) {
    await requireArchived(archivedBinding, original.sha256);
    return;
  }
  const source = await readRegularFile(bindingPath);
  if (source === undefined) await requireArchived(archivedBinding, original.sha256);
  else if (digest(source) !== original.sha256)
    throw changed(`profile ${expectation.profile} binding revision changed`);

  if (original.target !== null) {
    const targetPath = configPath(runtimeDir, original.target.name);
    const archivedTarget = join(archiveRoot, "targets", `${original.target.name}.json`);
    const targetSource = await readRegularFile(targetPath);
    if (original.target.receiptSha256 === null) {
      if (targetSource !== undefined)
        throw changed(`target receipt ${original.target.name} appeared after the plan`);
    } else if (targetSource === undefined) {
      await requireArchived(archivedTarget, original.target.receiptSha256);
    } else {
      if (digest(targetSource) !== original.target.receiptSha256)
        throw changed(`target receipt ${original.target.name} revision changed`);
      requireTarget(parseTargetConfig(targetSource), original.target, targetPath);
      await archiveExact(targetPath, archivedTarget, original.target.receiptSha256);
    }
  }
  if (source !== undefined) await archiveExact(bindingPath, archivedBinding, original.sha256);
}

async function withReconciliationLocks<T>(
  stateDirs: readonly string[],
  profiles: readonly string[],
  runtimeDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const names = [...new Set(profiles)].sort();
  return await withProviderSessionProfileExclusions(stateDirs, names, () =>
    withRuntimeAllocationLock(runtimeDir, async () => {
      const stores = stateDirs.map((stateDir) => new ProfileBindingStore(stateDir));
      const acquire = async (index: number): Promise<T> =>
        index === stores.length
          ? await operation()
          : await stores[index]!.withProfileLocks(names, () => acquire(index + 1));
      return await acquire(0);
    }),
  );
}

function namespacePaths(primary: string, additional: readonly string[]): string[] {
  const values = [primary, ...additional];
  if (values.some((value) => !isAbsolute(value)))
    throw new CliError(
      "profile_backup_failed",
      "restore binding state directories must be absolute",
    );
  const unique = [...new Set(values)];
  if (unique.length !== values.length)
    throw new CliError("profile_backup_failed", "restore binding state directories must be unique");
  return [primary, ...unique.slice(1).sort()];
}

function requireMatchingOperation(
  plan: RestoreBindingReconciliationPlan,
  profiles: readonly string[],
  sourceBackend: string,
  destinationBackend: string,
  setDigest: string,
  stateDirs: readonly string[],
  runtimeDir: string,
): void {
  if (
    plan.sourceBackend !== sourceBackend ||
    plan.destinationBackend !== destinationBackend ||
    plan.setDigest !== setDigest ||
    plan.runtimeDir !== runtimeDir ||
    JSON.stringify(plan.namespaces.map((entry) => entry.stateDir)) !== JSON.stringify(stateDirs) ||
    JSON.stringify(plan.namespaces[0]?.profiles.map((entry) => entry.profile)) !==
      JSON.stringify([...new Set(profiles)].sort())
  )
    throw changed("restore binding reconciliation journal conflicts with this operation");
}

function requireExpectedPlan(
  plan: RestoreBindingReconciliationPlan,
  expectedReconciliationDigest: string,
): void {
  if (plan.reconciliationDigest !== expectedReconciliationDigest)
    throw new CliError(
      "profile_backup_failed",
      "restore binding reconciliation plan changed",
      `repeat --dry-run and use --expected-reconciliation-digest ${plan.reconciliationDigest} only after reviewing the new exact plan`,
    );
}

function reconciliationJournalPath(stateDir: string, setDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(setDigest))
    throw new CliError("profile_backup_failed", "invalid backup set digest");
  return join(stateDir, "restore-reconciliations", `${setDigest}.json`);
}

async function readJournal(path: string): Promise<ReconciliationJournal | undefined> {
  const source = await readRegularFile(path);
  if (source === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw changed("restore binding reconciliation journal is invalid JSON");
  }
  if (!isJournal(value)) throw changed("restore binding reconciliation journal is invalid");
  const { reconciliationDigest, ...base } = value.plan;
  if (digest(JSON.stringify(base)) !== reconciliationDigest)
    throw changed("restore binding reconciliation journal digest is invalid");
  return value;
}

function isJournal(value: unknown): value is ReconciliationJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  const plan = journal.plan;
  return (
    journal.version === 1 &&
    (journal.status === "prepared" ||
      journal.status === "reserved" ||
      journal.status === "released") &&
    Array.isArray(journal.completed) &&
    journal.completed.every((entry) => typeof entry === "string") &&
    Array.isArray(journal.releasedNamespaces) &&
    journal.releasedNamespaces.every((entry) => typeof entry === "string") &&
    isPlan(plan)
  );
}

function isPlan(value: unknown): value is RestoreBindingReconciliationPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (
    plan.version !== 1 ||
    typeof plan.setDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(plan.setDigest) ||
    typeof plan.sourceBackend !== "string" ||
    typeof plan.destinationBackend !== "string" ||
    typeof plan.runtimeDir !== "string" ||
    !isAbsolute(plan.runtimeDir) ||
    !(plan.runtimeIdentity === null || isDirectoryIdentity(plan.runtimeIdentity)) ||
    typeof plan.reconciliationDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(plan.reconciliationDigest) ||
    !Array.isArray(plan.namespaces) ||
    plan.namespaces.length === 0
  )
    return false;
  return plan.namespaces.every((namespace) => {
    if (typeof namespace !== "object" || namespace === null || Array.isArray(namespace))
      return false;
    const candidate = namespace as Record<string, unknown>;
    if (
      typeof candidate.stateDir !== "string" ||
      !isAbsolute(candidate.stateDir) ||
      !isDirectoryIdentity(candidate.identity) ||
      !Array.isArray(candidate.profiles)
    )
      return false;
    return candidate.profiles.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const expectation = entry as Record<string, unknown>;
      if (typeof expectation.profile !== "string" || typeof expectation.owner !== "boolean")
        return false;
      if (expectation.binding === null) return true;
      if (typeof expectation.binding !== "object" || Array.isArray(expectation.binding))
        return false;
      const binding = expectation.binding as Record<string, unknown>;
      if (
        typeof binding.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(binding.sha256) ||
        typeof binding.backend !== "string"
      )
        return false;
      if (binding.target === null) return true;
      if (typeof binding.target !== "object" || Array.isArray(binding.target)) return false;
      const target = binding.target as Record<string, unknown>;
      return (
        typeof target.name === "string" &&
        typeof target.profile === "string" &&
        typeof target.backend === "string" &&
        typeof target.container === "string" &&
        Number.isSafeInteger(target.slot) &&
        (target.receiptSha256 === null ||
          (typeof target.receiptSha256 === "string" && /^[0-9a-f]{64}$/.test(target.receiptSha256)))
      );
    });
  });
}

function isDirectoryIdentity(value: unknown): value is DirectoryIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return Number.isSafeInteger(identity.device) && Number.isSafeInteger(identity.inode);
}

async function verifyPlanDirectories(plan: RestoreBindingReconciliationPlan): Promise<void> {
  const runtimeIdentity = await directoryIdentity(plan.runtimeDir);
  if (plan.runtimeIdentity !== null && !sameIdentity(runtimeIdentity, plan.runtimeIdentity))
    throw changed("restore runtime directory identity changed");
  for (const namespace of plan.namespaces)
    if (!sameIdentity(await directoryIdentity(namespace.stateDir), namespace.identity))
      throw changed(`restore state namespace identity changed: ${namespace.stateDir}`);
}

async function optionalDirectoryIdentity(path: string): Promise<DirectoryIdentity | null> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink())
    throw changed(`restore reconciliation path is not an owned directory: ${path}`);
  return { device: details.dev, inode: details.ino };
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity> {
  const identity = await optionalDirectoryIdentity(path);
  if (identity === null) throw changed(`restore reconciliation directory does not exist: ${path}`);
  return identity;
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function writeJournal(path: string, journal: ReconciliationJournal): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function archiveExact(source: string, destination: string, expectedSha256: string) {
  const existing = await readRegularFile(destination);
  if (existing !== undefined) {
    if (digest(existing) !== expectedSha256)
      throw changed(`archive receipt changed: ${destination}`);
    const current = await readRegularFile(source);
    if (current !== undefined) {
      if (digest(current) !== expectedSha256) throw changed(`source receipt changed: ${source}`);
      await rm(source);
      await syncDirectory(dirname(source));
    }
    return;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rename(source, destination);
  await chmod(destination, 0o600);
  await syncDirectory(dirname(destination));
  await syncDirectory(dirname(source));
}

async function requireArchived(path: string, expectedSha256: string): Promise<void> {
  const source = await readRegularFile(path);
  if (source === undefined || digest(source) !== expectedSha256)
    throw changed(`archived receipt is missing or changed: ${path}`);
}

async function readRegularFile(path: string): Promise<string | undefined> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink())
      throw changed(`receipt is not a regular file: ${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requireTarget(
  observed: Target,
  expected: Pick<Target, "name" | "profile" | "backend" | "container" | "slot">,
  path: string,
): void {
  if (
    observed.name !== expected.name ||
    observed.profile !== expected.profile ||
    observed.backend !== expected.backend ||
    observed.container !== expected.container ||
    observed.slot !== expected.slot
  )
    throw changed(`target receipt identity disagrees with its binding: ${path}`);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function digest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function changed(message: string): CliError {
  return new CliError(
    "profile_backup_failed",
    message,
    "do not remove any receipt; repeat the dry-run and inspect the exact reconciliation evidence",
  );
}
