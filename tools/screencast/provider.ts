/** Opt-in provider: the capture owner, not driver detach, releases the lease.
 * Standard agent-browser.plugin.v1 contract; no driver modifications.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleProviderRequest } from "../../cli/provider.ts";
import { browserFarm } from "../../cli/runtime.ts";

export async function captureProvider(
  source: string,
  root: string,
  session: string,
): Promise<string> {
  const farm = browserFarm();
  const leasePath = join(root, "provider-lease.json");
  return handleProviderRequest(source, {
    provisionProfile: farm.provisionProfile.bind(farm),
    destroy: async () => {
      throw new Error("capture cleanup requires the exact saved lease");
    },
    sessions: {
      async launch(requested) {
        if (requested !== session) throw new Error("foreign capture session");
        // Single launch only, including an uncertain response. Never replace a target.
        writeFileSync(join(root, "provider-launch-intent"), "launch\n", {
          flag: "wx",
          mode: 0o600,
        });
        const result = await farm.sessions.launch(session);
        writeFileSync(leasePath, JSON.stringify(result.receipt), { flag: "wx", mode: 0o600 });
        return result;
      },
      async release(requested, token, expected) {
        const saved = JSON.parse(readFileSync(leasePath, "utf8"));
        if (
          requested !== session ||
          saved.lease !== token ||
          saved.target?.name !== expected?.browserTarget ||
          saved.profile !== expected?.browserProfile ||
          saved.target?.backend !== expected?.backend
        )
          throw new Error("driver detach does not match capture lease");
        // Detach acknowledgement is not a release receipt. The host retains the
        // source on both successful driver exit and transport/capture failure.
        writeFileSync(
          join(root, "driver-detached.json"),
          JSON.stringify({
            session,
            lease: token,
            target: saved.target,
            released: false,
            retainedForCaptureOwner: true,
          }),
          { mode: 0o600 },
        );
        return { released: false, preserved: true, profile: saved.profile };
      },
    },
  });
}
if (import.meta.main) {
  const [root, session] = process.argv.slice(2);
  if (!root || !session) throw new Error("capture root and exact session required");
  process.stdout.write(await captureProvider(await Bun.stdin.text(), root, session));
}
