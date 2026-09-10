import { createHash } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./errors.ts";
import type { CreateResult } from "./farm.ts";
import type { BrowserFleet } from "./fleet.ts";
import { providerProfileName, validateName } from "./model.ts";
import { ProfileBindingStore } from "./profile-binding.ts";

export const MAX_DISPOSABLE_SESSIONS = 16;
export interface SessionReceipt {
  version: 1;
  session: string;
  profile: string;
  persistent: boolean;
  lease: string;
  createdAt: string;
  target: { name: string; backend: string } | null;
}
type SessionFarm = Pick<
  BrowserFleet,
  "provisionProfile" | "destroy" | "deleteProfile" | "listProfiles" | "list" | "bindings"
>;

/** One registry lock serializes prepare/launch/close across short-lived providers.
 * Leases survive process exit; only an exact close/release can relinquish one.
 * No timer steals a profile from an agent or a human handoff.
 */
export class ProviderSessions {
  private readonly directory: string;
  private readonly locks: ProfileBindingStore;
  constructor(
    private readonly farm: SessionFarm,
    stateDir: string,
  ) {
    this.directory = join(stateDir, "provider-sessions");
    this.locks = new ProfileBindingStore(join(stateDir, "session-locks"));
  }
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.withProfileLock("registry", fn);
  }
  private path(session: string): string {
    if (!session || session.length > 128 || [...session].some((c) => c.charCodeAt(0) < 32))
      throw new CliError(
        "invalid_session",
        "session must be 1–128 characters without control characters",
      );
    return join(this.directory, `${createHash("sha256").update(session).digest("hex")}.json`);
  }
  async read(session: string): Promise<SessionReceipt | undefined> {
    try {
      const r = JSON.parse(await readFile(this.path(session), "utf8"));
      if (
        r.version !== 1 ||
        r.session !== session ||
        typeof r.persistent !== "boolean" ||
        typeof r.lease !== "string" ||
        !/^[a-f0-9]{32}$/.test(r.lease) ||
        typeof r.createdAt !== "string" ||
        !Number.isFinite(Date.parse(r.createdAt)) ||
        !(
          r.target === null ||
          (typeof r.target?.name === "string" && typeof r.target?.backend === "string")
        )
      )
        throw new Error("invalid receipt");
      validateName(r.profile);
      return r as SessionReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof CliError) throw error;
      throw new CliError(
        "invalid_session_receipt",
        `cannot read session ${session}: ${(error as Error).message}`,
      );
    }
  }
  async list(): Promise<SessionReceipt[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: SessionReceipt[] = [];
    for (const file of files.filter((f) => /^[a-f0-9]{64}\.json$/.test(f))) {
      const raw = JSON.parse(await readFile(join(this.directory, file), "utf8"));
      if (typeof raw.session !== "string" || this.path(raw.session) !== join(this.directory, file))
        throw new CliError("invalid_session_receipt", "session filename and identity disagree");
      const receipt = await this.read(raw.session);
      if (receipt) result.push(receipt);
    }
    return result;
  }
  private async write(r: SessionReceipt): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const path = this.path(r.session);
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await open(tmp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(r)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(tmp, path);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(tmp, { force: true });
    }
  }
  async prepare(session: string, profile?: string): Promise<SessionReceipt> {
    return this.lock(() => this.prepareLocked(session, profile));
  }
  private async prepareLocked(session: string, profile?: string): Promise<SessionReceipt> {
    this.path(session);
    if (profile !== undefined) validateName(profile);
    const existing = await this.read(session);
    if (existing) {
      if (profile !== undefined && (!existing.persistent || existing.profile !== profile))
        throw new CliError(
          "session_already_prepared",
          `session ${session} already uses ${existing.profile}`,
          "close or release that session before choosing another profile",
        );
      return existing;
    }
    // Preserve pre-existing durable profiles during the forward transition.
    const implicit = profile === undefined;
    const legacy = providerProfileName(session);
    const named = profile ?? legacy;
    let home = await this.farm.bindings.read(named);
    if (!home) {
      const matches = (await this.farm.listProfiles()).filter((p) => p.name === named);
      if (matches.length > 1)
        throw new CliError(
          "profile_backend_conflict",
          `profile ${named} exists on more than one backend`,
        );
      if (matches[0]) home = await this.farm.bindings.bindProfile(named, matches[0].backend);
    }
    if (profile === undefined && home) profile = legacy;
    const receipts = await this.list();
    if (profile !== undefined) {
      const owner = receipts.find((r) => r.profile === profile);
      if (owner)
        throw new CliError(
          "profile_leased",
          `profile ${profile} is in use by session ${owner.session}`,
          "wait for its owner to close; do not share their driver session or steal the lease",
        );
      const binding = await this.farm.bindings.read(profile);
      const live = binding?.target ?? (await this.farm.list()).find((t) => t.profile === profile);
      if (live && !(implicit && profile === legacy))
        throw new CliError(
          "profile_leased",
          `profile ${profile} already has target ${live.name}`,
          "close the existing owner before preparing a new session",
        );
    } else if (receipts.filter((r) => !r.persistent).length >= MAX_DISPOSABLE_SESSIONS) {
      throw new CliError(
        "disposable_capacity_exhausted",
        `all ${MAX_DISPOSABLE_SESSIONS} disposable session slots are occupied`,
        "use session list; close your finished session or release its exact lease after confirming no active work or human handoff remains",
      );
    }
    const receipt: SessionReceipt = {
      version: 1,
      session,
      profile: profile ?? `tmp-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      persistent: profile !== undefined,
      lease: crypto.randomUUID().replaceAll("-", ""),
      createdAt: new Date().toISOString(),
      target: null,
    };
    await this.write(receipt);
    return receipt;
  }
  async launch(session: string): Promise<{ result: CreateResult; receipt: SessionReceipt }> {
    return this.lock(async () => {
      const receipt = await this.prepareLocked(session);
      // Persist intent before any volume/target mutation. A failed launch remains
      // visible and releasable, rather than silently leaking an untracked volume.
      const result = await this.farm.provisionProfile({ profile: receipt.profile });
      receipt.target = { name: result.name, backend: result.backend };
      await this.write(receipt);
      return { result, receipt };
    });
  }
  async release(
    session: string,
    lease: string,
    expected?: { browserTarget: string; browserProfile: string; backend: string },
  ): Promise<{ released: boolean; profile?: string; preserved?: boolean }> {
    return this.lock(async () => {
      const receipt = await this.read(session);
      if (!receipt || receipt.lease !== lease) return { released: false };
      if (
        expected &&
        (receipt.profile !== expected.browserProfile ||
          receipt.target?.name !== expected.browserTarget ||
          receipt.target.backend !== expected.backend)
      )
        throw new CliError(
          "session_target_changed",
          "provider cleanup does not match its session receipt",
        );
      const binding = await this.farm.bindings.read(receipt.profile);
      let target = receipt.target ?? binding?.target;
      if (!target && binding) {
        const matches = (await this.farm.list()).filter((t) => t.profile === receipt.profile);
        if (matches.length > 1)
          throw new CliError(
            "session_target_changed",
            "profile has multiple targets; refusing ambiguous cleanup",
          );
        const match = matches[0];
        if (match) target = { name: match.name, backend: match.backend };
      }
      if (target) {
        if (receipt.target && binding?.target && binding.target.name !== receipt.target.name)
          throw new CliError(
            "session_target_changed",
            "profile target changed; refusing stale cleanup",
          );
        await this.farm.destroy(target.name, target.backend, receipt.profile);
      }
      if (!receipt.persistent && binding) await this.farm.deleteProfile(receipt.profile);
      await rm(this.path(session));
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { released: true, profile: receipt.profile, preserved: receipt.persistent };
    });
  }
  async profileForSession(session: string): Promise<string> {
    return (await this.read(session))?.profile ?? providerProfileName(session);
  }
}
