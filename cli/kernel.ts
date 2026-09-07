import { link, open, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpConnection, normalizeDebuggerUrl } from "../client/cdp.ts";
import { CliError } from "./errors.ts";
import { PROFILE_DATA_PATH } from "./model.ts";

const REQUEST_TIMEOUT_MS = 120_000;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const CHROMIUM_INFO = `import json
from supervisor.childutils import getRPCInterface
rpc = getRPCInterface({"SUPERVISOR_SERVER_URL": "unix:///var/run/supervisor.sock"})
print(json.dumps(rpc.supervisor.getProcessInfo("chromium")))`;

interface ChromiumState {
  statename: string;
  pid: number;
  exitstatus: number;
}

/** Kernel's native tar.zst, without an Agentbrowse wrapper or re-encoding. */
export interface ProfileArchiveResult {
  readonly name: string;
  readonly backend: string;
  readonly path: string;
}

export async function validateProfileArchive(path: string): Promise<string> {
  const absolute = resolve(path);
  if (!(await stat(absolute)).isFile())
    throw new CliError("invalid_profile_archive", "profile archive must be a regular file");
  const file = await open(absolute, "r");
  try {
    const stat = await file.stat();
    const magic = Buffer.alloc(4);
    const { bytesRead } = await file.read(magic, 0, 4, 0);
    if (!stat.isFile() || bytesRead !== 4 || !magic.equals(ZSTD_MAGIC)) {
      throw new CliError("invalid_profile_archive", "expected a Kernel tar.zst profile archive");
    }
  } finally {
    await file.close();
  }
  return absolute;
}

export class KernelBrowser {
  constructor(
    readonly baseUrl: string,
    readonly cdpUrl: string = baseUrl,
    private readonly legacyAutoRestart = false,
    private readonly request: typeof fetch = fetch,
  ) {}

  private async call(path: string, options: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(this.baseUrl + path, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CliError(
        "kernel_request_failed",
        `Kernel ${path} could not be reached: ${(error as Error).message}`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CliError(
        "kernel_request_failed",
        `Kernel ${path} failed (HTTP ${response.status})`,
      );
    }
    return response;
  }

  private async exec(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
    const response = await this.call("/process/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, args, timeout_sec: 60, as_root: true }),
    });
    const value = (await response.json()) as Record<string, unknown> | null;
    if (!Number.isInteger(value?.["exit_code"]) || typeof value?.["stdout_b64"] !== "string") {
      throw new CliError("kernel_request_failed", "Kernel returned an invalid process result");
    }
    return {
      code: value["exit_code"] as number,
      stdout: Buffer.from(value["stdout_b64"], "base64").toString(),
    };
  }

  async stop(): Promise<void> {
    const args = ["-c", "/etc/supervisor/supervisord.conf"];
    let current = await this.chromiumState();
    const quiescent = (value: ChromiumState) =>
      value.statename === "STOPPED" ||
      (!this.legacyAutoRestart && value.statename === "EXITED" && value.exitstatus === 0);
    if (!quiescent(current)) {
      const originalPid = current.pid;
      if (current.statename !== "RUNNING" || originalPid <= 0)
        throw new CliError(
          "profile_not_quiescent",
          `Chromium is not ready to close: ${current.statename}`,
        );
      try {
        const version = await this.request(`${this.cdpUrl}/json/version`, {
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        });
        if (!version.ok) {
          await version.body?.cancel();
          throw new Error(`CDP version returned HTTP ${version.status}`);
        }
        const browser = (await version.json()) as { webSocketDebuggerUrl: string };
        const cdp = await CdpConnection.connect(
          normalizeDebuggerUrl(this.cdpUrl, browser.webSocketDebuggerUrl),
        );
        try {
          await cdp.command("Browser.close", {}, undefined, 30_000);
        } finally {
          cdp.close();
        }
      } catch (error) {
        throw new CliError(
          "profile_not_quiescent",
          `Chromium could not close gracefully: ${String(error)}`,
        );
      }
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        current = await this.chromiumState();
        if (quiescent(current)) break;
        if (
          this.legacyAutoRestart &&
          current.statename === "RUNNING" &&
          current.pid !== originalPid
        ) {
          // A legacy target still uses autorestart=true. Its original browser
          // finished graceful exit; stop the successor before deleting the VM.
          await this.exec("supervisorctl", [...args, "stop", "chromium"]);
          current = await this.chromiumState();
          break;
        }
        await Bun.sleep(100);
      }
      if (!quiescent(current))
        throw new CliError("profile_not_quiescent", "Kernel did not confirm Chromium exited");
    }
    // Persist the guest's filesystem buffers before Hypeman removes the VM.
    const synced = await this.exec("sync", []);
    if (synced.code !== 0)
      throw new CliError("profile_not_quiescent", "Kernel could not sync the profile");
  }

  async ensureStarted(): Promise<void> {
    const result = await this.exec("supervisorctl", [
      "-c",
      "/etc/supervisor/supervisord.conf",
      "start",
      "chromium",
    ]);
    if (result.code !== 0 && (await this.chromiumState()).statename !== "RUNNING")
      throw new CliError("kernel_request_failed", "Kernel could not start Chromium");
  }

  private async chromiumState(): Promise<ChromiumState> {
    const result = await this.exec("python3", ["-c", CHROMIUM_INFO]);
    let state: Partial<ChromiumState> | null = null;
    try {
      state = JSON.parse(result.stdout);
    } catch {
      /* Validate below. */
    }
    if (
      result.code !== 0 ||
      !Number.isInteger(state?.pid) ||
      !Number.isInteger(state?.exitstatus) ||
      typeof state?.statename !== "string"
    )
      throw new CliError(
        "kernel_request_failed",
        "Kernel could not read Chromium supervisor state",
      );
    return state as ChromiumState;
  }

  async importProfile(path: string): Promise<void> {
    const body = new FormData();
    body.set("profile_archive", Bun.file(path), "profile.tar.zst");
    const response = await this.call("/configure", { method: "POST", body });
    const result = (await response.json()) as { ok?: unknown } | null;
    if (result?.ok !== true)
      throw new CliError("kernel_request_failed", "Kernel did not confirm profile configuration");
  }

  async exportProfile(path: string): Promise<void> {
    const temporary = `${path}.partial-${crypto.randomUUID()}`;
    // Never expose a partial archive at the requested path or overwrite one.
    const file = await open(temporary, "wx", 0o600);
    try {
      await this.stop();
      const response = await this.call(
        `/fs/download_dir_zstd?path=${encodeURIComponent(PROFILE_DATA_PATH)}`,
      );
      if (response.body === null)
        throw new CliError("invalid_profile_archive", "Kernel returned an empty archive");
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          let offset = 0;
          while (offset < value.length) {
            const written = await file.write(value.subarray(offset));
            offset += written.bytesWritten;
          }
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      await file.sync();
      await validateProfileArchive(temporary);
      await link(temporary, path);
    } finally {
      await file.close();
      await rm(temporary, { force: true });
    }
  }
}
