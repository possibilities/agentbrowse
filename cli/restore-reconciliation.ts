import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
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
  type ReceiptRevision,
  readReceipt,
  sameReceiptLineage,
  sameReceiptRevision,
} from "./receipt.ts";
import {
  assertNoProviderSessionProfiles,
  withProviderSessionProfileExclusions,
} from "./sessions.ts";

export interface RestoreBindingReconciliationPlan {
  readonly version: 2;
  readonly setDigest: string;
  readonly sourceBackend: string;
  readonly destinationBackend: string;
  readonly destinationHostIdentity: string;
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
    readonly revision: ReceiptRevision;
    readonly backend: string;
    readonly target: null | {
      readonly name: string;
      readonly profile: string;
      readonly backend: string;
      readonly container: string;
      readonly slot: number;
      readonly receiptRevision: ReceiptRevision | null;
    };
  };
}

interface ReconciliationJournal {
  readonly version: 2;
  readonly plan: RestoreBindingReconciliationPlan;
  readonly status: "prepared" | "reserved" | "releasing" | "released";
  readonly completed: readonly string[];
  readonly reservations: readonly NamespaceReservation[];
  readonly releaseIntents: readonly string[];
  readonly releasedNamespaces: readonly string[];
}

interface NamespaceReservation {
  readonly stateDir: string;
  readonly pending: readonly { readonly profile: string; readonly revision: ReceiptRevision }[];
}

interface BindingObservation {
  readonly binding: ProfileBinding;
  readonly revision: ReceiptRevision;
  readonly targetReceiptRevision: ReceiptRevision | null;
}

export async function planRestoreBindingReconciliation(
  profiles: readonly string[],
  sourceBackend: string,
  destinationBackend: string,
  destinationHostIdentity: string,
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
    destinationHostIdentity,
    setDigest,
    stateDirs,
    runtimeDir,
  );
}

export async function applyRestoreBindingReconciliation(
  profiles: readonly string[],
  sourceBackend: string,
  destinationBackend: string,
  destinationHostIdentity: string,
  setDigest: string,
  primaryStateDir: string,
  additionalStateDirs: readonly string[],
  runtimeDir: string,
  expectedReconciliationDigest: string,
  hooks: {
    readonly beforeNamespace?: (stateDir: string, index: number) => void | Promise<void>;
  } = {},
): Promise<RestoreBindingReconciliationPlan> {
  const stateDirs = namespacePaths(primaryStateDir, additionalStateDirs);
  const initialJournal = await readJournal(reconciliationJournalPath(primaryStateDir, setDigest));
  const initialPlan =
    initialJournal === undefined
      ? await buildPlanLocked(
          profiles,
          sourceBackend,
          destinationBackend,
          destinationHostIdentity,
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
        destinationHostIdentity,
        setDigest,
        stateDirs,
        runtimeDir,
        initialPlan === undefined ? undefined : { runtimeIdentity: initialPlan.runtimeIdentity },
      );
      requireExpectedPlan(plan, expectedReconciliationDigest);
      journal = {
        version: 2,
        plan,
        status: "prepared",
        completed: [],
        reservations: [],
        releaseIntents: [],
        releasedNamespaces: [],
      };
      await writeJournal(journalPath, journal);
    } else {
      requireMatchingOperation(
        journal.plan,
        profiles,
        sourceBackend,
        destinationBackend,
        destinationHostIdentity,
        setDigest,
        stateDirs,
        runtimeDir,
      );
      requireExpectedPlan(journal.plan, expectedReconciliationDigest);
      if (journal.status === "released" || journal.status === "releasing")
        throw changed("released restore reconciliation authorization is terminal");
    }
    await verifyPlanDirectories(journal.plan);

    const completed = new Set(journal.completed);
    for (const [namespaceIndex, namespace] of journal.plan.namespaces.entries()) {
      await hooks.beforeNamespace?.(namespace.stateDir, namespaceIndex);
      const store = new ProfileBindingStore(namespace.stateDir);
      const owners = namespace.profiles.filter((entry) => entry.owner);
      for (const expectation of namespace.profiles) {
        if (!expectation.owner) {
          if ((await readReceipt(store.bindingPath(expectation.profile))) !== undefined)
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
      if (
        owners.length > 0 &&
        !journal.reservations.some((entry) => entry.stateDir === namespace.stateDir)
      ) {
        const inspection = await store.inspectRestoreReleaseLocked(
          owners.map((entry) => entry.profile),
          journal.plan.destinationBackend,
          journal.plan.setDigest,
        );
        if (!inspection.journal || inspection.pending.length !== owners.length)
          throw changed(`restore reservations are incomplete in ${namespace.stateDir}`);
        journal = {
          ...journal,
          reservations: [
            ...journal.reservations,
            { stateDir: namespace.stateDir, pending: inspection.pending },
          ].sort((left, right) => left.stateDir.localeCompare(right.stateDir)),
        };
      }
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
  destinationHostIdentity: string,
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
    destinationHostIdentity,
    setDigest,
    namespacePaths(primaryStateDir, additionalStateDirs),
    runtimeDir,
  );
  requireExpectedPlan(journal.plan, expectedReconciliationDigest);
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

export async function releaseRestoreBindingReconciliation<T>(
  plan: RestoreBindingReconciliationPlan,
  hostRelease: () => Promise<T>,
): Promise<T> {
  const stateDirs = plan.namespaces.map((namespace) => namespace.stateDir);
  const profiles = plan.namespaces[0]!.profiles.map((entry) => entry.profile);
  return await withReconciliationLocks(stateDirs, profiles, plan.runtimeDir, async () => {
    await verifyPlanDirectories(plan);
    const path = reconciliationJournalPath(plan.namespaces[0]!.stateDir, plan.setDigest);
    let journal = await readJournal(path);
    if (journal === undefined || journal.plan.reconciliationDigest !== plan.reconciliationDigest)
      throw changed("restore binding reconciliation journal is missing or changed");
    if (journal.status === "released") return await hostRelease();

    const released = new Set(journal.releasedNamespaces);
    const reservations = new Map(
      journal.reservations.map((reservation) => [reservation.stateDir, reservation]),
    );
    for (const namespace of plan.namespaces) {
      if (released.has(namespace.stateDir)) continue;
      const observed = await validateNamespaceReleaseLocked(
        plan,
        namespace,
        reservations.get(namespace.stateDir)?.pending,
      );
      reservations.set(namespace.stateDir, { stateDir: namespace.stateDir, pending: observed });
    }
    const intents = new Set(journal.releaseIntents);
    for (const namespace of plan.namespaces)
      if (!released.has(namespace.stateDir)) intents.add(namespace.stateDir);
    journal = {
      ...journal,
      status: "releasing",
      reservations: [...reservations.values()].sort((left, right) =>
        left.stateDir.localeCompare(right.stateDir),
      ),
      releaseIntents: [...intents].sort(),
    };
    await writeJournal(path, journal);

    const result = await hostRelease();
    for (const namespace of plan.namespaces) {
      if (released.has(namespace.stateDir)) continue;
      const expectedPending = reservations.get(namespace.stateDir)?.pending ?? [];
      await validateNamespaceReleaseLocked(plan, namespace, expectedPending);
      const owners = namespace.profiles
        .filter((entry) => entry.owner)
        .map((entry) => entry.profile);
      if (owners.length > 0)
        await new ProfileBindingStore(namespace.stateDir).releaseRestorePartialLocked(
          owners,
          plan.destinationBackend,
          plan.setDigest,
          expectedPending,
        );
      released.add(namespace.stateDir);
      journal = { ...journal, releasedNamespaces: [...released].sort() };
      await writeJournal(path, journal);
    }
    await writeJournal(path, { ...journal, status: "released", completed: [] });
    return result;
  });
}

async function validateNamespaceReleaseLocked(
  plan: RestoreBindingReconciliationPlan,
  namespace: RestoreBindingNamespacePlan,
  expectedPending?: readonly {
    readonly profile: string;
    readonly revision: ReceiptRevision;
  }[],
): Promise<readonly { readonly profile: string; readonly revision: ReceiptRevision }[]> {
  const store = new ProfileBindingStore(namespace.stateDir);
  const owners: string[] = [];
  for (const expectation of namespace.profiles) {
    const path = store.bindingPath(expectation.profile);
    const receipt = await readReceipt(path);
    if (!expectation.owner) {
      if (receipt !== undefined)
        throw changed(`profile ${expectation.profile} appeared in ${namespace.stateDir}`);
      continue;
    }
    owners.push(expectation.profile);
    const binding = receipt === undefined ? undefined : parseProfileBinding(receipt.source);
    const pending =
      binding?.backend === plan.destinationBackend &&
      binding.target === null &&
      binding.pendingRestore === plan.setDigest;
    if (pending) {
      await requireRetiredReceipts(plan, namespace, expectation);
      continue;
    }
    if (expectation.binding === null) {
      if (binding !== undefined)
        throw changed(`profile ${expectation.profile} changed before reservation release`);
      continue;
    }
    if (
      receipt !== undefined &&
      sameReceiptRevision(receipt.revision, expectation.binding.revision)
    ) {
      await requireOriginalTarget(plan, expectation);
      continue;
    }
    if (receipt === undefined) {
      await requireRetiredReceipts(plan, namespace, expectation);
      continue;
    }
    throw changed(`profile ${expectation.profile} changed before reservation release`);
  }
  if (owners.length > 0) {
    const inspection = await store.inspectRestoreReleaseLocked(
      owners,
      plan.destinationBackend,
      plan.setDigest,
    );
    if (
      expectedPending !== undefined &&
      !reservationSubsetMatches(inspection.pending, expectedPending)
    )
      throw changed(`restore reservation revisions changed in ${namespace.stateDir}`);
    return inspection.pending;
  }
  if (expectedPending !== undefined && expectedPending.length > 0)
    throw changed(`restore reservation revisions changed in ${namespace.stateDir}`);
  return [];
}

async function requireOriginalTarget(
  plan: RestoreBindingReconciliationPlan,
  expectation: RestoreBindingExpectation,
): Promise<void> {
  const target = expectation.binding?.target;
  if (target === null || target === undefined) return;
  const receipt = await readReceipt(configPath(plan.runtimeDir, target.name));
  if (target.receiptRevision === null) {
    if (receipt !== undefined)
      throw changed(`target receipt ${target.name} appeared after the plan`);
    return;
  }
  if (receipt === undefined || !sameReceiptRevision(receipt.revision, target.receiptRevision))
    throw changed(`target receipt ${target.name} changed after the plan`);
  requireTarget(
    parseTargetConfig(receipt.source),
    target,
    configPath(plan.runtimeDir, target.name),
  );
}

async function requireRetiredReceipts(
  plan: RestoreBindingReconciliationPlan,
  namespace: RestoreBindingNamespacePlan,
  expectation: RestoreBindingExpectation,
): Promise<void> {
  const original = expectation.binding;
  if (original === null) return;
  const archiveRoot = join(
    namespace.stateDir,
    "retired-bindings",
    "restore-reconciliations",
    plan.setDigest,
  );
  await requireArchived(
    join(archiveRoot, "profiles", `${expectation.profile}.json`),
    original.revision,
  );
  if (original.target !== null) {
    const live = await readReceipt(configPath(plan.runtimeDir, original.target.name));
    if (live !== undefined)
      throw changed(`target receipt ${original.target.name} reappeared after retirement`);
    if (original.target.receiptRevision !== null)
      await requireArchived(
        join(archiveRoot, "targets", `${original.target.name}.json`),
        original.target.receiptRevision,
      );
  }
}

async function buildPlanLocked(
  profiles: readonly string[],
  sourceBackend: string,
  destinationBackend: string,
  destinationHostIdentity: string,
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
    version: 2 as const,
    setDigest,
    sourceBackend,
    destinationBackend,
    destinationHostIdentity,
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
                    revision: observation.revision,
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
                            receiptRevision: observation.targetReceiptRevision,
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
  const receipt = await readReceipt(path);
  if (receipt === undefined) return undefined;
  const binding = parseProfileBinding(receipt.source);
  if (binding.profile !== profile) throw changed(`binding filename and profile disagree: ${path}`);
  let targetReceiptRevision: ReceiptRevision | null = null;
  if (binding.target !== null) {
    const targetPath = configPath(runtimeDir, binding.target.name);
    const targetReceipt = await readReceipt(targetPath);
    if (targetReceipt !== undefined) {
      const target = parseTargetConfig(targetReceipt.source);
      requireTarget(target, binding.target, targetPath);
      targetReceiptRevision = targetReceipt.revision;
    }
  }
  return { binding, revision: receipt.revision, targetReceiptRevision };
}

async function retireExpectedBinding(
  store: ProfileBindingStore,
  stateDir: string,
  runtimeDir: string,
  setDigest: string,
  destinationBackend: string,
  expectation: RestoreBindingExpectation,
): Promise<void> {
  const bindingPath = store.bindingPath(expectation.profile);
  const currentReceipt = await readReceipt(bindingPath);
  const current =
    currentReceipt === undefined ? undefined : parseProfileBinding(currentReceipt.source);
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

  const archiveRoot = join(stateDir, "retired-bindings", "restore-reconciliations", setDigest);
  const archivedBinding = join(archiveRoot, "profiles", `${expectation.profile}.json`);
  if (
    current !== undefined &&
    current.backend === destinationBackend &&
    current.target === null &&
    (current.pendingRestore === setDigest || current.restoredFrom === setDigest)
  ) {
    await requireArchived(archivedBinding, original.revision);
    return;
  }
  if (currentReceipt === undefined) await requireArchived(archivedBinding, original.revision);
  else if (!sameReceiptRevision(currentReceipt.revision, original.revision))
    throw changed(`profile ${expectation.profile} binding revision changed`);

  if (original.target !== null) {
    const targetPath = configPath(runtimeDir, original.target.name);
    const archivedTarget = join(archiveRoot, "targets", `${original.target.name}.json`);
    const targetReceipt = await readReceipt(targetPath);
    if (original.target.receiptRevision === null) {
      if (targetReceipt !== undefined)
        throw changed(`target receipt ${original.target.name} appeared after the plan`);
    } else if (targetReceipt === undefined) {
      await requireArchived(archivedTarget, original.target.receiptRevision);
    } else {
      if (!sameReceiptRevision(targetReceipt.revision, original.target.receiptRevision))
        throw changed(`target receipt ${original.target.name} revision changed`);
      requireTarget(parseTargetConfig(targetReceipt.source), original.target, targetPath);
      await archiveExact(targetPath, archivedTarget, original.target.receiptRevision);
    }
  }
  if (currentReceipt !== undefined)
    await archiveExact(bindingPath, archivedBinding, original.revision);
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
  destinationHostIdentity: string,
  setDigest: string,
  stateDirs: readonly string[],
  runtimeDir: string,
): void {
  if (
    plan.sourceBackend !== sourceBackend ||
    plan.destinationBackend !== destinationBackend ||
    plan.destinationHostIdentity !== destinationHostIdentity ||
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
  const receipt = await readReceipt(path);
  if (receipt === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(receipt.source);
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
  if (
    !(
      journal.version === 2 &&
      (journal.status === "prepared" ||
        journal.status === "reserved" ||
        journal.status === "releasing" ||
        journal.status === "released") &&
      Array.isArray(journal.completed) &&
      journal.completed.every((entry) => typeof entry === "string") &&
      Array.isArray(journal.reservations) &&
      journal.reservations.every(isNamespaceReservation) &&
      Array.isArray(journal.releaseIntents) &&
      journal.releaseIntents.every((entry) => typeof entry === "string") &&
      Array.isArray(journal.releasedNamespaces) &&
      journal.releasedNamespaces.every((entry) => typeof entry === "string") &&
      isPlan(plan)
    )
  )
    return false;
  const typedPlan = plan as RestoreBindingReconciliationPlan;
  const stateDirs = new Set(typedPlan.namespaces.map((namespace) => namespace.stateDir));
  const allProfiles = new Set(
    typedPlan.namespaces.flatMap((namespace) =>
      namespace.profiles.filter((entry) => entry.owner).map((entry) => entry.profile),
    ),
  );
  const completed = journal.completed as string[];
  const reservations = journal.reservations as NamespaceReservation[];
  const intents = journal.releaseIntents as string[];
  const released = journal.releasedNamespaces as string[];
  if (
    new Set(completed).size !== completed.length ||
    completed.some((profile) => !allProfiles.has(profile)) ||
    new Set(reservations.map((entry) => entry.stateDir)).size !== reservations.length ||
    reservations.some(
      (entry) =>
        !stateDirs.has(entry.stateDir) ||
        new Set(entry.pending.map((pending) => pending.profile)).size !== entry.pending.length ||
        entry.pending.some(
          (pending) =>
            !typedPlan.namespaces
              .find((namespace) => namespace.stateDir === entry.stateDir)
              ?.profiles.some(
                (expectation) => expectation.owner && expectation.profile === pending.profile,
              ),
        ),
    ) ||
    new Set(intents).size !== intents.length ||
    intents.some((stateDir) => !stateDirs.has(stateDir)) ||
    new Set(released).size !== released.length ||
    released.some((stateDir) => !intents.includes(stateDir))
  )
    return false;
  if (journal.status === "released" && released.length !== stateDirs.size) return false;
  if (
    (journal.status === "prepared" || journal.status === "reserved") &&
    (intents.length > 0 || released.length > 0)
  )
    return false;
  return true;
}

function isNamespaceReservation(value: unknown): value is NamespaceReservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reservation = value as Record<string, unknown>;
  return (
    typeof reservation.stateDir === "string" &&
    isAbsolute(reservation.stateDir) &&
    Array.isArray(reservation.pending) &&
    reservation.pending.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const pending = entry as Record<string, unknown>;
      return typeof pending.profile === "string" && isReceiptRevision(pending.revision);
    })
  );
}

function isPlan(value: unknown): value is RestoreBindingReconciliationPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (
    plan.version !== 2 ||
    typeof plan.setDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(plan.setDigest) ||
    typeof plan.sourceBackend !== "string" ||
    typeof plan.destinationBackend !== "string" ||
    typeof plan.destinationHostIdentity !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      plan.destinationHostIdentity,
    ) ||
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
      if (!isReceiptRevision(binding.revision) || typeof binding.backend !== "string") return false;
      if (binding.target === null) return true;
      if (typeof binding.target !== "object" || Array.isArray(binding.target)) return false;
      const target = binding.target as Record<string, unknown>;
      return (
        typeof target.name === "string" &&
        typeof target.profile === "string" &&
        typeof target.backend === "string" &&
        typeof target.container === "string" &&
        Number.isSafeInteger(target.slot) &&
        (target.receiptRevision === null || isReceiptRevision(target.receiptRevision))
      );
    });
  });
}

function isReceiptRevision(value: unknown): value is ReceiptRevision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const revision = value as Record<string, unknown>;
  return (
    typeof revision.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(revision.sha256) &&
    typeof revision.device === "string" &&
    /^[0-9]+$/.test(revision.device) &&
    typeof revision.inode === "string" &&
    /^[0-9]+$/.test(revision.inode) &&
    typeof revision.generation === "string" &&
    /^[0-9]+$/.test(revision.generation) &&
    typeof revision.changedNs === "string" &&
    /^[0-9]+$/.test(revision.changedNs) &&
    typeof revision.size === "string" &&
    /^[0-9]+$/.test(revision.size) &&
    typeof revision.modifiedNs === "string" &&
    /^[0-9]+$/.test(revision.modifiedNs)
  );
}

function reservationSubsetMatches(
  pending: readonly { readonly profile: string; readonly revision: ReceiptRevision }[],
  expected: readonly { readonly profile: string; readonly revision: ReceiptRevision }[],
): boolean {
  const byProfile = new Map(expected.map((entry) => [entry.profile, entry.revision]));
  return pending.every((entry) => {
    const revision = byProfile.get(entry.profile);
    return revision !== undefined && sameReceiptRevision(entry.revision, revision);
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

async function archiveExact(
  source: string,
  destination: string,
  expectedRevision: ReceiptRevision,
) {
  const existing = await readReceipt(destination);
  if (existing !== undefined) {
    if (!sameReceiptLineage(existing.revision, expectedRevision))
      throw changed(`archive receipt changed: ${destination}`);
    const current = await readReceipt(source);
    if (current !== undefined) {
      if (!sameReceiptRevision(current.revision, expectedRevision))
        throw changed(`source receipt changed: ${source}`);
      await rm(source);
      await syncDirectory(dirname(source));
    }
    return;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const current = await readReceipt(source);
  if (current === undefined || !sameReceiptRevision(current.revision, expectedRevision))
    throw changed(`source receipt changed: ${source}`);
  await rename(source, destination);
  const archived = await readReceipt(destination);
  if (archived === undefined || !sameReceiptLineage(archived.revision, expectedRevision))
    throw changed(`archived receipt identity changed: ${destination}`);
  await syncDirectory(dirname(destination));
  await syncDirectory(dirname(source));
}

async function requireArchived(path: string, expectedRevision: ReceiptRevision): Promise<void> {
  const receipt = await readReceipt(path);
  if (receipt === undefined || !sameReceiptLineage(receipt.revision, expectedRevision))
    throw changed(`archived receipt is missing or changed: ${path}`);
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
