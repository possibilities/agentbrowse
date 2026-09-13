import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KernelBrowser } from "../cli/kernel.ts";

const archive = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 10, 0, 255, 128]);

function fixture(legacy = false) {
  const calls: string[] = [];
  const state = {
    process: { statename: "RUNNING", pid: 42, exitstatus: 0 },
    closeFails: false,
    invalidArchive: false,
    syncFails: false,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/devtools/browser/test") {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      }
      if (url.pathname === "/json/version") {
        return Response.json({
          webSocketDebuggerUrl: `${server.url.origin.replace("http", "ws")}/devtools/browser/test`,
        });
      }
      if (url.pathname === "/process/exec") {
        const body = (await request.json()) as {
          command: string;
          args: string[];
          as_root: boolean;
        };
        expect(body.as_root).toBe(true);
        const action =
          body.command === "python3" ? "info" : body.command === "sync" ? "sync" : body.args[2]!;
        calls.push(action);
        if (action === "stop") state.process = { statename: "STOPPED", pid: 0, exitstatus: 0 };
        if (action === "start") state.process = { statename: "RUNNING", pid: 44, exitstatus: 0 };
        return Response.json({
          exit_code: action === "sync" && state.syncFails ? 1 : 0,
          stdout_b64: Buffer.from(action === "info" ? JSON.stringify(state.process) : "").toString(
            "base64",
          ),
        });
      }
      if (url.pathname === "/fs/download_dir_zstd") {
        calls.push("archive");
        expect(url.searchParams.get("path")).toBe("/home/kernel/user-data");
        return new Response(state.invalidArchive ? "not an archive" : archive);
      }
      if (url.pathname === "/configure") {
        calls.push("configure");
        const body = await request.formData();
        expect(Buffer.from(await (body.get("profile_archive") as File).arrayBuffer())).toEqual(
          archive,
        );
        expect(body.has("start_url")).toBe(false);
        state.process = { statename: "RUNNING", pid: 44, exitstatus: 0 };
        return Response.json({ ok: true });
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message)) as { id: number; method: string };
        expect(request.method).toBe("Browser.close");
        calls.push("close");
        if (state.closeFails) {
          socket.send(
            JSON.stringify({ id: request.id, error: { code: -1, message: "close failed" } }),
          );
          return;
        }
        state.process = legacy
          ? { statename: "RUNNING", pid: 43, exitstatus: 0 }
          : { statename: "EXITED", pid: 0, exitstatus: 0 };
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      },
    },
  });
  return {
    server,
    calls,
    state,
    kernel: new KernelBrowser(server.url.origin, server.url.origin, legacy),
  };
}

test("Kernel export waits for graceful browser exit and sync before streaming a private native archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kernel-archive-"));
  const { kernel, server, calls, state } = fixture();
  try {
    const path = join(directory, "profile.tar.zst");
    await kernel.exportProfile(path);
    expect(calls).toEqual(["info", "close", "info", "sync", "archive"]);
    expect(await readFile(path)).toEqual(archive);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await kernel.importProfile(path);
    expect(calls.at(-1)).toBe("configure");
    await writeFile(path, "existing destination");
    await expect(kernel.exportProfile(path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("existing destination");
    expect(await readdir(directory)).toEqual(["profile.tar.zst"]);
    state.process = { statename: "RUNNING", pid: 45, exitstatus: 0 };
    state.closeFails = true;
    const before = calls.filter((c) => c === "archive").length;
    await expect(kernel.exportProfile(join(directory, "unsafe.tar.zst"))).rejects.toMatchObject({
      code: "profile_not_quiescent",
    });
    expect(calls.filter((c) => c === "archive")).toHaveLength(before);
    expect(await readdir(directory)).toEqual(["profile.tar.zst"]);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy supervisor restarts are stopped only after the original browser exits", async () => {
  const { kernel, calls, server } = fixture(true);
  try {
    await kernel.stop();
    expect(calls).toEqual(["info", "close", "info", "stop", "info", "sync"]);
  } finally {
    server.stop(true);
  }
});

test("an abnormal exit is not considered a flushed profile and sync failures are refused", async () => {
  const { kernel, state, calls, server } = fixture();
  try {
    state.process = { statename: "EXITED", pid: 0, exitstatus: 1 };
    await expect(kernel.stop()).rejects.toMatchObject({ code: "profile_not_quiescent" });
    expect(calls).toEqual(["info"]);
    state.process = { statename: "EXITED", pid: 0, exitstatus: 0 };
    state.syncFails = true;
    await expect(kernel.stop()).rejects.toMatchObject({ code: "profile_not_quiescent" });
  } finally {
    server.stop(true);
  }
});

test("an explicitly relaunched browser starts through Kernel's supervisor", async () => {
  const { kernel, state, calls, server } = fixture();
  try {
    state.process = { statename: "EXITED", pid: 0, exitstatus: 0 };
    await kernel.ensureStarted();
    expect(calls).toEqual(["start"]);
    expect(state.process.statename).toBe("RUNNING");
  } finally {
    server.stop(true);
  }
});

test("invalid archive responses never publish a destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kernel-archive-failure-"));
  const { kernel, state, server } = fixture();
  try {
    state.invalidArchive = true;
    await expect(kernel.exportProfile(join(directory, "profile.tar.zst"))).rejects.toMatchObject({
      code: "invalid_profile_archive",
    });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

function uploadFixture(options: { wrongDigest?: boolean; cleanupFails?: boolean } = {}) {
  const calls: string[] = [];
  let uploaded = Buffer.alloc(0);
  let destination = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/process/exec") {
        const body = (await request.json()) as { command: string; args: string[] };
        calls.push(body.command);
        if (body.command === "sha256sum") {
          const digest = options.wrongDigest
            ? "0".repeat(64)
            : createHash("sha256").update(uploaded).digest("hex");
          return Response.json({
            exit_code: 0,
            stdout_b64: Buffer.from(`${digest}  ${destination}\n`).toString("base64"),
          });
        }
        return Response.json({
          exit_code: body.command === "rm" && options.cleanupFails ? 1 : 0,
          stdout_b64: "",
        });
      }
      if (url.pathname === "/fs/write_file") {
        destination = url.searchParams.get("path") ?? "";
        expect(url.searchParams.get("mode")).toBe("0600");
        expect(request.headers.get("content-type")).toBe("application/octet-stream");
        uploaded = Buffer.from(await request.arrayBuffer());
        calls.push("write_file");
        return new Response(null, { status: 201 });
      }
      if (url.pathname === "/fs/file_info") {
        calls.push("file_info");
        expect(url.searchParams.get("path")).toBe(destination);
        return Response.json({
          name: destination.split("/").at(-1),
          path: destination,
          size_bytes: uploaded.length,
          is_dir: false,
          mod_time: "2026-09-13T00:00:00Z",
          mode: "-rw-------",
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  return {
    server,
    calls,
    get destination() {
      return destination;
    },
    get uploaded() {
      return uploaded;
    },
    kernel: new KernelBrowser(server.url.origin),
  };
}

test("upload staging streams bytes into a private guest path and verifies size and digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kernel-upload-"));
  const fixture = uploadFixture();
  try {
    const bytes = Buffer.from("verified video bytes");
    const source = join(directory, "sample video.mp4");
    await writeFile(source, bytes);
    const result = await fixture.kernel.stageUpload(source);
    expect(result).toEqual({
      path: fixture.destination,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(result.path).toMatch(/^\/tmp\/agentbrowse-upload-[a-f0-9]{32}\/sample video\.mp4$/);
    expect(fixture.uploaded).toEqual(bytes);
    expect(fixture.calls).toEqual([
      "mkdir",
      "chown",
      "write_file",
      "chown",
      "file_info",
      "sha256sum",
    ]);
  } finally {
    fixture.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("upload staging refuses unverifiable bytes and removes only its exact partial directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kernel-upload-mismatch-"));
  const fixture = uploadFixture({ wrongDigest: true });
  try {
    const source = join(directory, "sample.mp4");
    await writeFile(source, "source bytes");
    await expect(fixture.kernel.stageUpload(source)).rejects.toMatchObject({
      code: "upload_verification_failed",
    });
    expect(fixture.calls.at(-1)).toBe("rm");
  } finally {
    fixture.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("upload staging reports a failed partial cleanup instead of hiding it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kernel-upload-cleanup-"));
  const fixture = uploadFixture({ wrongDigest: true, cleanupFails: true });
  try {
    const source = join(directory, "sample.mp4");
    await writeFile(source, "source bytes");
    await expect(fixture.kernel.stageUpload(source)).rejects.toMatchObject({
      code: "upload_cleanup_failed",
    });
  } finally {
    fixture.server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("upload staging requires an absolute regular local file before contacting Kernel", async () => {
  const fixture = uploadFixture();
  try {
    await expect(fixture.kernel.stageUpload("relative.mp4")).rejects.toMatchObject({
      code: "invalid_upload_file",
    });
    await expect(fixture.kernel.stageUpload(tmpdir())).rejects.toMatchObject({
      code: "invalid_upload_file",
    });
    expect(fixture.calls).toEqual([]);
  } finally {
    fixture.server.stop(true);
  }
});
