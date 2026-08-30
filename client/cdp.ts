const CDP_TIMEOUT_MS = 5_000;

interface CdpError {
  code: number;
  message: string;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: CdpError;
}

interface PendingCommand {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface TemporaryTarget {
  id: string;
  type: string;
  webSocketDebuggerUrl: string;
}

interface TargetInfo {
  targetId: string;
  type: string;
}

export class CdpConnection {
  private readonly pending = new Map<number, PendingCommand>();
  private nextId = 1;
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => this.failPending(new Error("CDP connection closed")));
    socket.addEventListener("error", () => this.failPending(new Error("CDP connection failed")));
  }

  static async connect(url: string, timeoutMs = CDP_TIMEOUT_MS): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`CDP WebSocket did not open within ${timeoutMs} ms`));
      }, timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("CDP WebSocket failed while opening"));
        },
        { once: true },
      );
    });
    return new CdpConnection(socket);
  }

  command<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP connection is not open"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${CDP_TIMEOUT_MS} ms`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.socket.send(
        JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
      );
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new Error("CDP connection closed"));
    this.socket.close();
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let response: CdpResponse;
    try {
      response = JSON.parse(data) as CdpResponse;
    } catch {
      return;
    }
    if (typeof response.id !== "number") return;
    const command = this.pending.get(response.id);
    if (!command) return;
    this.pending.delete(response.id);
    clearTimeout(command.timeout);
    if (response.error) {
      command.reject(
        new Error(`CDP command failed (${response.error.code}): ${response.error.message}`),
      );
      return;
    }
    command.resolve(response.result);
  }

  private failPending(error: Error): void {
    for (const command of this.pending.values()) {
      clearTimeout(command.timeout);
      command.reject(error);
    }
    this.pending.clear();
  }
}

export class TemporaryCdpPage {
  private closed = false;

  private constructor(
    private readonly browserConnection: CdpConnection,
    readonly targetId: string,
    private readonly sessionId: string,
    private readonly previousVisibleTargetId: string | null,
    private readonly preserveAsLastPage: boolean,
  ) {}

  static async open(cdpBaseUrl: string, documentUrl: string): Promise<TemporaryCdpPage> {
    const browserTarget = await browserDebuggerTarget(cdpBaseUrl);
    const browserConnection = await CdpConnection.connect(
      normalizeDebuggerUrl(cdpBaseUrl, browserTarget.webSocketDebuggerUrl),
    );
    const previousPages = await inspectPageTargets(browserConnection);
    let targetId: string | null = null;
    try {
      const created = await browserConnection.command<{ targetId?: string }>(
        "Target.createTarget",
        {
          url: documentUrl,
          background: false,
        },
      );
      if (typeof created.targetId !== "string") throw new Error("CDP did not return a target id");
      targetId = created.targetId;
      const attached = await browserConnection.command<{ sessionId?: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );
      if (typeof attached.sessionId !== "string") {
        throw new Error("CDP did not attach to the temporary target");
      }
      return new TemporaryCdpPage(
        browserConnection,
        targetId,
        attached.sessionId,
        previousPages.visibleTargetId,
        previousPages.count === 0,
      );
    } catch (error) {
      if (targetId !== null) {
        await browserConnection.command("Target.closeTarget", { targetId }).catch(() => undefined);
      }
      browserConnection.close();
      throw error;
    }
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.browserConnection.command<{
      result?: { value?: T; description?: string };
      exceptionDetails?: { text?: string };
    }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      this.sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        `CDP evaluation failed: ${result.exceptionDetails.text ?? result.result?.description ?? "unknown exception"}`,
      );
    }
    return result.result?.value as T;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.preserveAsLastPage) {
      await this.browserConnection
        .command("Page.navigate", { url: "about:blank" }, this.sessionId)
        .catch(() => undefined);
    }
    await this.browserConnection
      .command("Target.detachFromTarget", { sessionId: this.sessionId })
      .catch(() => undefined);
    if (!this.preserveAsLastPage) {
      await this.browserConnection
        .command("Target.closeTarget", { targetId: this.targetId })
        .catch(() => undefined);
      if (this.previousVisibleTargetId !== null) {
        await this.browserConnection
          .command("Target.activateTarget", { targetId: this.previousVisibleTargetId })
          .catch(() => undefined);
      }
    }
    this.browserConnection.close();
  }
}

export function cdpJsonEndpoint(cdpBaseUrl: string, path: "list" | "version"): string {
  return new URL(`/json/${path}`, normalizedBase(cdpBaseUrl)).href;
}

export function normalizeDebuggerUrl(cdpBaseUrl: string, debuggerUrl: string): string {
  const base = new URL(normalizedBase(cdpBaseUrl));
  const normalized = new URL(debuggerUrl);
  normalized.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  normalized.host = base.host;
  normalized.username = "";
  normalized.password = "";
  return normalized.href;
}

function normalizedBase(cdpBaseUrl: string): string {
  return cdpBaseUrl.endsWith("/") ? cdpBaseUrl : `${cdpBaseUrl}/`;
}

async function browserDebuggerTarget(cdpBaseUrl: string): Promise<TemporaryTarget> {
  const response = await fetch(cdpJsonEndpoint(cdpBaseUrl, "version"), {
    signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`could not inspect the CDP browser target: HTTP ${response.status}`);
  }
  const value = await response.json();
  if (!value || typeof value !== "object")
    throw new Error("CDP returned an invalid browser target");
  const target = value as Record<string, unknown>;
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error("CDP browser target has no debugger WebSocket");
  }
  return { id: "browser", type: "browser", webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

async function inspectPageTargets(
  browserConnection: CdpConnection,
): Promise<{ count: number; visibleTargetId: string | null }> {
  const response = await browserConnection.command<{ targetInfos?: TargetInfo[] }>(
    "Target.getTargets",
  );
  const pages = (response.targetInfos ?? []).filter(
    (target): target is TargetInfo => target.type === "page" && typeof target.targetId === "string",
  );
  let visibleTargetId: string | null = null;
  for (const page of pages) {
    const attached = await browserConnection
      .command<{ sessionId?: string }>("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      })
      .catch(() => null);
    if (!attached || typeof attached.sessionId !== "string") continue;
    try {
      const evaluated = await browserConnection.command<{
        result?: { value?: boolean };
      }>(
        "Runtime.evaluate",
        {
          expression: "document.visibilityState === 'visible'",
          returnByValue: true,
        },
        attached.sessionId,
      );
      if (evaluated.result?.value === true) visibleTargetId = page.targetId;
    } catch {
      // A target can disappear while the browser target list is being inspected.
    } finally {
      await browserConnection
        .command("Target.detachFromTarget", { sessionId: attached.sessionId })
        .catch(() => undefined);
    }
    if (visibleTargetId !== null) break;
  }
  return { count: pages.length, visibleTargetId };
}
