import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
      if (existing !== undefined && existing.backend !== target.backend) {
        throw new CliError(
          "profile_backend_mismatch",
          `Browser profile ${target.profile} is bound to backend ${existing.backend}, not ${target.backend}`,
          "use the profile's bound backend so its cookies and authentication remain available",
        );
      }
      const binding = { profile: target.profile, backend: target.backend, target };
      await this.write(binding);
      return binding;
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
      await writeFile(temporaryPath, renderProfileBinding(binding), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  private async withProfileLock<T>(profile: string, operation: () => Promise<T>): Promise<T> {
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
  if (value.target === null) return { profile, backend, target: null };
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
  return { profile, backend, target };
}

export function renderProfileBinding(binding: ProfileBinding): string {
  return `${JSON.stringify(
    {
      version: PROFILE_BINDING_RECEIPT_VERSION,
      profile: binding.profile,
      backend: binding.backend,
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
