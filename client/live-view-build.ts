import { resolve } from "node:path";

export const LIVE_VIEW_BUILD_PREFIX_ENV = "AGENTBROWSE_LIVE_VIEW_PREFIX";

type Environment = Readonly<Record<string, string | undefined>>;

export function liveViewBuildPrefix(
  fallback: string,
  environment: Environment = process.env,
): string {
  const configured = environment[LIVE_VIEW_BUILD_PREFIX_ENV]?.trim();
  return configured ? resolve(configured) : fallback;
}
