import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CliError } from "./errors.ts";
import { type Target, targetFor, validateBackendId, validateName } from "./model.ts";

export const PROFILE_BINDING_RECEIPT_VERSION = 1;

const PROFILE_LOCK_WAIT_MS = 10_000;
const PROFILE_LOCK_STALE_MS = 90_000;

export interface ProfileBinding {
  readonly profile: string;
  readonly backend: string;
  readonly target: Target | null;
  readonly pendingImport?: true;
  readonly pendingRestore?: string;
  readonly restoredFrom?: string;
}

export function requireReadyProfile(binding: ProfileBinding | undefined): void {
  if (binding?.pendingImport)
    throw new CliError(
      "profile_import_pending",
      `Browser profile ${binding.profile} has an unfinished import`,
      "destroy its temporary target if present, then retry profile import with the intended archive, or explicitly delete the new profile",
    );
  if (binding?.pendingRestore)
    throw new CliError(
      "profile_restore_pending",
      `Browser profile ${binding.profile} has an unfinished full-volume restore`,
      "retry backup restore with the same set, or use its explicit reservation release after abandoning host staging",
    );
}

export class ProfileBindingStore {
  constructor(readonly stateDir: string) {}

  async read(profile: string): Promise<ProfileBinding | undefined> {
    const path = this.path(profile);
    try {
      return parseProfileBinding(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async bindProfile(profile: string, backend: string): Promise<ProfileBinding> {
    validateName(profile);
    validateBackendId(backend);
    return await this.withProfileLock(profile, async () => {
      const existing = await this.read(profile);
      requireReadyProfile(existing);
      if (existing !== undefined && existing.backend !== backend) {
        throw new CliError(
          "profile_backend_mismatch",
          `Browser profile ${profile} is bound to backend ${existing.backend}, not ${backend}`,
          "use the profile's bound backend so its cookies and authentication remain available",
        );
      }
      const binding = existing ?? { profile, backend, target: null };
      await this.write(binding);
      return binding;
    });
  }

  async bindTarget(target: Target): Promise<ProfileBinding> {
    return await this.withProfileLock(target.profile, async () => {
      const existing = await this.read(target.profile);
      requireReadyProfile(existing);
      if (existing !== undefined && existing.backend !== target.backend) {
        throw new CliError(
          "profile_backend_mismatch",
          `Browser profile ${target.profile} is bound to backend ${existing.backend}, not ${target.backend}`,
          "use the profile's bound backend so its cookies and authentication remain available",
        );
      }
      const binding = {
        profile: target.profile,
        backend: target.backend,
        target,
        ...(existing?.restoredFrom ? { restoredFrom: existing.restoredFrom } : {}),
      };
      await this.write(binding);
      return binding;
    });
  }

  async reserveRestore(
    profiles: readonly string[],
    backend: string,
    setDigest: string,
  ): Promise<void> {
    validateBackendId(backend);
    if (!/^[0-9a-f]{64}$/.test(setDigest))
      throw new CliError("profile_backup_failed", "invalid backup set digest");
    const names = [...new Set(profiles)].sort();
    for (const profile of names) validateName(profile);
    await this.withProfileLocks(names, async () => {
      const existing = await Promise.all(names.map((profile) => this.read(profile)));
      for (const [index, binding] of existing.entries()) {
        const profile = names[index]!;
        if (
          binding !== undefined &&
          (binding.backend !== backend ||
            ((binding.pendingRestore !== setDigest || binding.target !== null) &&
              (binding.restoredFrom !== setDigest || binding.target !== null)))
        ) {
          throw new CliError("profile_exists", `Browser profile ${profile} already exists`);
        }
      }
      const journal = await this.readRestoreJournal(setDigest);
      if (
        journal !== undefined &&
        (journal.backend !== backend || canonicalNames(journal.profiles) !== canonicalNames(names))
      ) {
        throw new CliError(
          "profile_backup_failed",
          "restore operation journal conflicts with this set",
        );
      }
      await this.writeRestoreJournal({
        version: 1,
        backend,
        setDigest,
        profiles: names,
        completed: journal?.completed ?? [],
      });
      for (const [index, profile] of names.entries()) {
        if (existing[index]?.restoredFrom !== setDigest) {
          await this.write({
            profile,
            backend,
            target: null,
            pendingRestore: setDigest,
          });
        }
      }
    });
  }

  async completeRestore(
    profiles: readonly string[],
    backend: string,
    setDigest: string,
  ): Promise<void> {
    validateBackendId(backend);
    const names = [...new Set(profiles)].sort();
    await this.withProfileLocks(names, async () => {
      const journal = await this.requireRestoreJournal(names, backend, setDigest);
      const completed = new Set(journal.completed);
      for (const profile of names) {
        const binding = await this.read(profile);
        if (binding?.backend !== backend || binding.target !== null) {
          throw new CliError("profile_backup_failed", `restore reservation changed for ${profile}`);
        }
        if (binding.restoredFrom !== setDigest) {
          if (binding.pendingRestore !== setDigest)
            throw new CliError(
              "profile_backup_failed",
              `restore reservation changed for ${profile}`,
            );
          await this.write({ profile, backend, target: null, restoredFrom: setDigest });
        }
        if (!completed.has(profile)) {
          completed.add(profile);
          await this.writeRestoreJournal({ ...journal, completed: [...completed].sort() });
        }
      }
    });
  }

  async releaseRestore(
    profiles: readonly string[],
    backend: string,
    setDigest: string,
  ): Promise<void> {
    validateBackendId(backend);
    const names = [...new Set(profiles)].sort();
    await this.withProfileLocks(names, async () => {
      await this.requireRestoreJournal(names, backend, setDigest);
      for (const profile of names) {
        const binding = await this.read(profile);
        if (binding?.backend !== backend || binding.pendingRestore !== setDigest) {
          throw new CliError("profile_backup_failed", `restore reservation changed for ${profile}`);
        }
      }
      for (const profile of names) {
        await rm(this.path(profile), { force: true });
      }
      await rm(this.restoreJournalPath(setDigest), { force: true });
    });
  }

  async withImport<T>(
    profile: string,
    backend: string,
    operation: (resume: boolean) => Promise<T>,
  ): Promise<T> {
    validateName(profile);
    validateBackendId(backend);
    return await this.withProfileLock(profile, async () => {
      const existing = await this.read(profile);
      if (existing !== undefined && (!existing.pendingImport || existing.backend !== backend)) {
        throw new CliError("profile_exists", `Browser profile ${profile} already exists`);
      }
      await this.write({ profile, backend, target: null, pendingImport: true });
      // Hold the reservation lock through the operation: a concurrent retry
      // must re-read readiness before it can overwrite an unfinished import.
      const result = await operation(existing?.pendingImport === true);
      await this.write({ profile, backend, target: null });
      return result;
    });
  }

  async clearTarget(target: Pick<Target, "name" | "profile" | "backend">): Promise<void> {
    await this.withProfileLock(target.profile, async () => {
      const existing = await this.read(target.profile);
      if (
        existing?.target === null ||
        existing?.target.name !== target.name ||
        existing.target.backend !== target.backend
      ) {
        return;
      }
      await this.write({ ...existing, target: null });
    });
  }

  async delete(profile: string, backend: string): Promise<void> {
    validateName(profile);
    validateBackendId(backend);
    await this.withProfileLock(profile, async () => {
      const existing = await this.read(profile);
      if (existing?.pendingRestore) requireReadyProfile(existing);
      if (existing !== undefined && existing.backend !== backend) {
        throw new CliError(
          "profile_backend_mismatch",
          `Browser profile ${profile} is bound to backend ${existing.backend}, not ${backend}`,
        );
      }
      await rm(this.path(profile), { force: true });
    });
  }

  private path(profile: string): string {
    validateName(profile);
    return join(this.stateDir, "profiles", `${profile}.json`);
  }

  private async write(binding: ProfileBinding): Promise<void> {
    const path = this.path(binding.profile);
    const directory = join(this.stateDir, "profiles");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(renderProfileBinding(binding));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
      // In particular, persist an import reservation before touching its volume.
      for (const parent of [directory, this.stateDir]) {
        const file = await open(parent, "r");
        try {
          await file.sync();
        } finally {
          await file.close();
        }
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private restoreJournalPath(setDigest: string): string {
    if (!/^[0-9a-f]{64}$/.test(setDigest))
      throw new CliError("profile_backup_failed", "invalid backup set digest");
    return join(this.stateDir, "restore-operations", `${setDigest}.json`);
  }

  private async readRestoreJournal(setDigest: string): Promise<RestoreJournal | undefined> {
    try {
      const value = JSON.parse(
        await readFile(this.restoreJournalPath(setDigest), "utf8"),
      ) as unknown;
      if (
        !isObject(value) ||
        value.version !== 1 ||
        typeof value.backend !== "string" ||
        value.setDigest !== setDigest ||
        !Array.isArray(value.profiles) ||
        !value.profiles.every((profile) => typeof profile === "string") ||
        !Array.isArray(value.completed) ||
        !value.completed.every((profile) => typeof profile === "string")
      )
        throw invalidBinding("restore operation journal is invalid");
      validateBackendAsBinding(value.backend);
      for (const profile of value.profiles) validateNameAsBinding(profile as string);
      if (
        canonicalNames(value.profiles as string[]) !== JSON.stringify(value.profiles) ||
        canonicalNames(value.completed as string[]) !== JSON.stringify(value.completed) ||
        new Set(value.profiles as string[]).size !== value.profiles.length ||
        new Set(value.completed as string[]).size !== value.completed.length ||
        (value.completed as string[]).some(
          (profile) => !(value.profiles as string[]).includes(profile),
        )
      )
        throw invalidBinding("restore operation journal names are invalid");
      return {
        version: 1,
        backend: value.backend,
        setDigest,
        profiles: value.profiles,
        completed: value.completed,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async requireRestoreJournal(
    profiles: readonly string[],
    backend: string,
    setDigest: string,
  ): Promise<RestoreJournal> {
    const journal = await this.readRestoreJournal(setDigest);
    if (
      journal === undefined ||
      journal.backend !== backend ||
      canonicalNames(journal.profiles) !== canonicalNames(profiles)
    )
      throw new CliError(
        "profile_backup_failed",
        "restore operation journal is missing or changed",
      );
    return journal;
  }

  private async writeRestoreJournal(journal: RestoreJournal): Promise<void> {
    const path = this.restoreJournalPath(journal.setDigest);
    const directory = join(this.stateDir, "restore-operations");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async withProfileLock<T>(profile: string, operation: () => Promise<T>): Promise<T> {
    validateName(profile);
    const directory = join(this.stateDir, "profile-locks");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, `${profile}.lock`);
    const deadline = Date.now() + PROFILE_LOCK_WAIT_MS;

    while (true) {
      try {
        await mkdir(path, { mode: 0o700 });
        try {
          await writeFile(join(path, "owner"), `${process.pid}\n`, {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          await rm(path, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const details = await stat(path);
          if (
            Date.now() - details.mtimeMs > PROFILE_LOCK_STALE_MS &&
            !(await profileBindingLockOwnerIsAlive(path))
          ) {
            await rm(path, { recursive: true, force: true });
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw lockError;
        }
        if (Date.now() >= deadline) {
          throw new CliError(
            "profile_binding_busy",
            `another Browser lifecycle operation is updating profile ${profile}`,
            "retry the agentbrowse or agent-browser command",
          );
        }
        await Bun.sleep(50);
      }
    }

    try {
      return await operation();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }

  private async withProfileLocks<T>(
    profiles: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const acquire = async (index: number): Promise<T> =>
      index === profiles.length
        ? await operation()
        : await this.withProfileLock(profiles[index]!, () => acquire(index + 1));
    return await acquire(0);
  }
}

interface RestoreJournal {
  readonly version: 1;
  readonly backend: string;
  readonly setDigest: string;
  readonly profiles: readonly string[];
  readonly completed: readonly string[];
}

function canonicalNames(names: readonly string[]): string {
  return JSON.stringify([...names].sort());
}

async function profileBindingLockOwnerIsAlive(path: string): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(join(path, "owner"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!/^[1-9][0-9]*\n$/.test(source)) return false;
  try {
    process.kill(Number(source.trim()), 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

export function parseProfileBinding(source: string): ProfileBinding {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw invalidBinding("profile binding receipt is not valid JSON");
  }
  if (!isObject(value) || value.version !== PROFILE_BINDING_RECEIPT_VERSION) {
    throw invalidBinding("profile binding receipt version is unsupported");
  }
  const profile = requiredString(value, "profile");
  const backend = requiredString(value, "backend");
  validateNameAsBinding(profile);
  validateBackendAsBinding(backend);
  if (value.pendingImport !== undefined && value.pendingImport !== true)
    throw invalidBinding("profile import state is invalid");
  if (
    value.pendingRestore !== undefined &&
    (typeof value.pendingRestore !== "string" || !/^[0-9a-f]{64}$/.test(value.pendingRestore))
  )
    throw invalidBinding("profile restore state is invalid");
  if (value.pendingImport === true && value.pendingRestore !== undefined)
    throw invalidBinding("profile cannot have two pending operations");
  const importing = value.pendingImport === true ? { pendingImport: true as const } : {};
  const restoring =
    typeof value.pendingRestore === "string" ? { pendingRestore: value.pendingRestore } : {};
  if (
    value.restoredFrom !== undefined &&
    (typeof value.restoredFrom !== "string" || !/^[0-9a-f]{64}$/.test(value.restoredFrom))
  )
    throw invalidBinding("profile restore provenance is invalid");
  if ((value.pendingImport === true || value.pendingRestore !== undefined) && value.restoredFrom)
    throw invalidBinding("pending profile cannot have restore provenance");
  const restored =
    typeof value.restoredFrom === "string" ? { restoredFrom: value.restoredFrom } : {};
  if (value.target === null)
    return { profile, backend, target: null, ...importing, ...restoring, ...restored };
  if (value.pendingImport === true || value.pendingRestore !== undefined)
    throw invalidBinding("a pending profile cannot have a published target");
  if (!isObject(value.target)) throw invalidBinding("profile binding target is invalid");
  const name = requiredString(value.target, "name");
  const container = requiredString(value.target, "container");
  const slot = value.target.slot;
  if (!Number.isSafeInteger(slot) || Number(slot) < 0 || Number(slot) > 999) {
    throw invalidBinding("profile binding target slot is invalid");
  }
  let target: Target;
  try {
    target = targetFor(name, Number(slot), { profile, backend, container });
  } catch (error) {
    throw invalidBinding((error as Error).message);
  }
  return { profile, backend, target, ...restored };
}

export function renderProfileBinding(binding: ProfileBinding): string {
  return `${JSON.stringify(
    {
      version: PROFILE_BINDING_RECEIPT_VERSION,
      profile: binding.profile,
      backend: binding.backend,
      ...(binding.pendingImport ? { pendingImport: true } : {}),
      ...(binding.pendingRestore ? { pendingRestore: binding.pendingRestore } : {}),
      ...(binding.restoredFrom ? { restoredFrom: binding.restoredFrom } : {}),
      target:
        binding.target === null
          ? null
          : {
              name: binding.target.name,
              container: binding.target.container,
              slot: binding.target.slot,
            },
    },
    null,
    2,
  )}\n`;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") {
    throw invalidBinding(`profile binding ${key} is invalid`);
  }
  return field;
}

function validateNameAsBinding(name: string): void {
  try {
    validateName(name);
  } catch (error) {
    throw invalidBinding((error as Error).message);
  }
}

function validateBackendAsBinding(backend: string): void {
  try {
    validateBackendId(backend);
  } catch (error) {
    throw invalidBinding((error as Error).message);
  }
}

function invalidBinding(message: string): CliError {
  return new CliError("invalid_profile_binding", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
