import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ProfileBindingStore } from "../cli/profile-binding.ts";
import { browserFarm, stateDir } from "../cli/runtime.ts";
import { loadAgentbrowseConfig } from "../config/deployment.ts";

const [backendId, destination, apply] = process.argv.slice(2);
if (
  !backendId ||
  !destination ||
  !isAbsolute(destination) ||
  (apply !== undefined && apply !== "--apply")
)
  throw new Error(
    "usage: bun tools/reclaim-archived-profiles.ts BACKEND ABSOLUTE_BACKUP_DIRECTORY [--apply]",
  );
const config = loadAgentbrowseConfig();
const backend = config.backends.find((b) => b.id === backendId);
if (!backend) throw new Error("backend is not configured");
const farm = browserFarm();
const state = stateDir(process.env);
const lock = new ProfileBindingStore(join(state, "session-locks"));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await lock.withProfileLock("registry", async () => {
  const remote = backend.remoteHost;
  const args = [
    "python3",
    "-",
    "--root",
    remote ? "/var/lib/agentbrowse-hypeman" : join(homedir(), ".local/share/ab-hypeman"),
    "--helper",
    remote
      ? "/usr/local/lib/agentbrowse/agentbrowse-hypeman"
      : new URL("../host/agentbrowse-hypeman", import.meta.url).pathname,
    "--backend",
    backendId,
    "--destination",
    destination,
    "--verify-only",
  ];
  const child = Bun.spawn(
    remote
      ? [
          "ssh",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=8",
          remote,
          ["sudo", "-n", ...args].map(quote).join(" "),
        ]
      : args,
    {
      stdin: new Blob([readFileSync(new URL("./archive-idle-profiles.py", import.meta.url))]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`backup validation failed: ${err}`);
  const volumes = JSON.parse(out) as {
    name: string;
    size_gb: number;
    tags: Record<string, string>;
  }[];
  const savedBindings = join(state, "archived-generated-bindings", backendId);
  if (apply) await mkdir(savedBindings, { recursive: true, mode: 0o700 });
  for (const volume of volumes) {
    const profile = volume.tags["dev.agentbrowse.profile"]!;
    if (
      volume.tags["dev.agentbrowse.backend"] !== backendId ||
      volume.name !== `agentbrowse-profile-${profile}` ||
      !/^agentscrape-[0-9]+-[a-z0-9-]+$/.test(profile)
    )
      throw new Error("refusing unowned profile");
    const binding = await farm.bindings.read(profile);
    if (binding && binding.backend !== backendId) throw new Error("profile backend changed");
    if (apply) {
      if (binding)
        await writeFile(join(savedBindings, `${profile}.json`), JSON.stringify(binding), {
          flag: "wx",
          mode: 0o600,
        });
      await farm.deleteProfile(profile);
    }
  }
  console.log(
    JSON.stringify({
      backend: backendId,
      verified: volumes.length,
      reclaimed: apply ? volumes.length : 0,
      reservedGiB: volumes.reduce((n, v) => n + v.size_gb, 0),
      backupDirectory: destination,
    }),
  );
});
