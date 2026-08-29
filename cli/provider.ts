import { loadAgentbrowseConfig } from "../config/deployment.ts";
import type { CreateResult, DestroyResult } from "./farm.ts";
import type { BrowserFleet } from "./fleet.ts";
import { providerProfileName } from "./model.ts";
import { browserFarm } from "./runtime.ts";

const PROTOCOL = "agent-browser.plugin.v1";
const CAPABILITY = "browser.provider";
const MAX_REQUEST_BYTES = 1024 * 1024;

type ProviderFarm = Pick<BrowserFleet, "provisionProfile" | "destroy">;

export interface ProviderIdentity {
  readonly name: string;
  readonly description: string;
}

const DEFAULT_PROVIDER_IDENTITY: ProviderIdentity = {
  name: "agentbrowse",
  description: "Manage ordered Kernel browser backends",
};

interface PluginRequest {
  protocol: string;
  type: string;
  capability: string;
  request: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success(body: Record<string, unknown>): string {
  return `${JSON.stringify({ protocol: PROTOCOL, success: true, ...body })}\n`;
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${JSON.stringify({ protocol: PROTOCOL, success: false, error: message })}\n`;
}

function parseRequest(source: string): PluginRequest {
  if (Buffer.byteLength(source) > MAX_REQUEST_BYTES) {
    throw new Error("provider request exceeds 1 MiB");
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    throw new Error("provider request is not valid JSON");
  }
  if (!isRecord(input)) throw new Error("provider request must be a JSON object");
  if (input.protocol !== PROTOCOL) {
    throw new Error(`unsupported plugin protocol: ${String(input.protocol ?? "missing")}`);
  }
  if (typeof input.type !== "string" || typeof input.capability !== "string") {
    throw new Error("provider request is missing its type or capability");
  }
  if (!isRecord(input.request)) throw new Error("provider request body must be a JSON object");
  return {
    protocol: input.protocol,
    type: input.type,
    capability: input.capability,
    request: input.request,
  };
}

function launchSession(request: PluginRequest): string {
  if (request.capability !== CAPABILITY) {
    throw new Error(`browser.launch requires capability ${CAPABILITY}`);
  }
  const session = request.request.session;
  if (typeof session !== "string" || session === "") {
    throw new Error("browser.launch requires a non-empty session name");
  }
  const launchOptions = request.request.launchOptions;
  if (isRecord(launchOptions)) {
    const engine = launchOptions.engine;
    if (engine !== undefined && engine !== "chrome") {
      throw new Error(
        `agentbrowse browser targets require the chrome engine, not ${String(engine)}`,
      );
    }
  }
  return session;
}

function launchResponse(result: CreateResult): string {
  return success({
    browser: {
      cdpUrl: result.cdpUrl,
      directPage: false,
      metadata: {
        backend: result.backend,
        browserTarget: result.name,
        browserProfile: result.profile,
        slot: result.slot,
        liveViewUrl: result.liveViewUrl,
      },
      cleanup: {
        backend: result.backend,
        browserTarget: result.name,
        browserProfile: result.profile,
      },
    },
  });
}

function closeTarget(request: PluginRequest): {
  backend: string;
  browserTarget: string;
  browserProfile: string;
} {
  if (request.capability !== CAPABILITY) {
    throw new Error(`browser.close requires capability ${CAPABILITY}`);
  }
  const name = request.request.browserTarget;
  const backend = request.request.backend;
  const profile = request.request.browserProfile;
  if (typeof name !== "string" || name === "") {
    throw new Error("browser.close requires browserTarget cleanup data");
  }
  if (typeof backend !== "string" || backend === "") {
    throw new Error("browser.close requires backend cleanup data");
  }
  if (typeof profile !== "string" || profile === "") {
    throw new Error("browser.close requires browserProfile cleanup data");
  }
  return { backend, browserTarget: name, browserProfile: profile };
}

function closeResponse(result: DestroyResult): string {
  return success({
    data: {
      browserTarget: result.name,
      browserProfile: result.profile,
      backend: result.backend,
      destroyed: result.destroyed,
    },
  });
}

export async function handleProviderRequest(
  source: string,
  farm: ProviderFarm,
  identity: ProviderIdentity = DEFAULT_PROVIDER_IDENTITY,
): Promise<string> {
  try {
    const input = parseRequest(source);
    if (input.type === "plugin.manifest") {
      return success({
        manifest: {
          name: identity.name,
          capabilities: [CAPABILITY],
          description: identity.description,
        },
      });
    }
    if (input.type === "browser.launch") {
      const profile = providerProfileName(launchSession(input));
      return launchResponse(await farm.provisionProfile({ profile }));
    }
    if (input.type === "browser.close") {
      const cleanup = closeTarget(input);
      return closeResponse(
        await farm.destroy(cleanup.browserTarget, cleanup.backend, cleanup.browserProfile),
      );
    }
    throw new Error(`unsupported provider request type: ${input.type}`);
  } catch (error) {
    return failure(error);
  }
}

export async function runProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const source = await Bun.stdin.text();
  try {
    const config = loadAgentbrowseConfig(env);
    process.stdout.write(await handleProviderRequest(source, browserFarm(env), config.provider));
  } catch (error) {
    process.stdout.write(failure(error));
  }
  return 0;
}
