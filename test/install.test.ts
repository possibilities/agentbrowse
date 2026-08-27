import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(join(import.meta.dir, ".."));
const script = join(root, "scripts", "install.sh");
const source = join(root, "cli", "main.ts");
const expectedSha = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"])
  .stdout.toString()
  .trim();
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const path of temporaryRoots) rmSync(path, { recursive: true, force: true });
});

interface Layout {
  root: string;
  binDir: string;
  stateDir: string;
  target: string;
  receipt: string;
}

function layout(): Layout {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agentbrowse-install-"));
  temporaryRoots.push(temporaryRoot);
  chmodSync(temporaryRoot, 0o700);
  const binDir = join(temporaryRoot, "bin");
  const stateDir = join(temporaryRoot, "state");
  mkdirSync(binDir, { mode: 0o755 });
  mkdirSync(stateDir, { mode: 0o700 });
  return {
    root: temporaryRoot,
    binDir,
    stateDir,
    target: join(binDir, "agentbrowse"),
    receipt: join(stateDir, "deployed-sha"),
  };
}

async function run(
  installLayout: Pick<Layout, "binDir" | "stateDir">,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["bash", script, ...args], {
    cwd: tmpdir(),
    env: {
      ...Bun.env,
      AGENTBROWSE_INSTALL_BIN_DIR: installLayout.binDir,
      AGENTBROWSE_INSTALL_STATE_DIR: installLayout.stateDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("installer links the exact checkout and records its deployed SHA", async () => {
  const installLayout = layout();
  const first = await run(installLayout, "--install");

  expect(first.exitCode).toBe(0);
  expect(lstatSync(installLayout.target).isSymbolicLink()).toBe(true);
  expect(readlinkSync(installLayout.target)).toBe(source);
  expect(readFileSync(installLayout.receipt, "utf8")).toBe(`${expectedSha}\n`);
  expect(lstatSync(installLayout.receipt).mode & 0o777).toBe(0o600);

  const previousReceipt = lstatSync(installLayout.receipt).ino;
  expect((await run(installLayout, "--install")).exitCode).toBe(0);
  expect(lstatSync(installLayout.receipt).ino).not.toBe(previousReceipt);
});

test("installer refuses foreign commands and uncorroborated receipts", async () => {
  const foreign = layout();
  writeFileSync(foreign.target, "foreign\n");
  const foreignResult = await run(foreign, "--install");
  expect(foreignResult.exitCode).toBe(1);
  expect(foreignResult.stderr).toContain("refusing foreign command path");
  expect(readFileSync(foreign.target, "utf8")).toBe("foreign\n");

  const uncorroborated = layout();
  writeFileSync(uncorroborated.receipt, `${expectedSha}\n`, { mode: 0o600 });
  const receiptResult = await run(uncorroborated, "--install");
  expect(receiptResult.exitCode).toBe(1);
  expect(receiptResult.stderr).toContain("uncorroborated deployed receipt");
});

test("uninstall removes only a corroborated installation", async () => {
  const installLayout = layout();
  symlinkSync(source, installLayout.target);
  writeFileSync(installLayout.receipt, `${expectedSha}\n`, { mode: 0o600 });

  expect((await run(installLayout, "--uninstall")).exitCode).toBe(0);
  expect(existsSync(installLayout.target)).toBe(false);
  expect(existsSync(installLayout.receipt)).toBe(false);
  expect((await run(installLayout, "--uninstall")).exitCode).toBe(0);
});
