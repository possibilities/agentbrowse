import { expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRACT, renderAgentHelp, renderHelp, renderTeaser } from "../cli/contract.ts";
import { run } from "../cli/main.ts";

const CLI = join(import.meta.dir, "..", "cli", "main.ts");

function validatorPath(): string {
  const root = process.env.AGENTSTART_DIR ?? join(homedir(), "code", "agentstart");
  return join(root, "scripts", "validate-agent-contract.ts");
}

test("guide --json emits the contract inside the ordinary envelope", async () => {
  const guide = Bun.spawnSync(["bun", "run", CLI, "guide", "--json"], { stdout: "pipe" });
  expect(guide.success).toBe(true);
  const envelope = JSON.parse(guide.stdout.toString());
  expect(envelope.ok).toBe(true);
  expect(envelope.error).toBe(null);
  expect(envelope.data.contract_version).toBe(1);
  expect(envelope.data).toEqual(JSON.parse(JSON.stringify(CONTRACT)));
});

test("the contract conforms to the fleet agent contract, version 1", () => {
  const validator = validatorPath();
  if (!existsSync(validator)) {
    console.warn(`skipping: ${validator} is absent; set AGENTSTART_DIR to check conformance`);
    return;
  }
  const emitted = Bun.spawnSync(["bun", "run", CLI, "guide", "--json"], { stdout: "pipe" });
  expect(emitted.success).toBe(true);
  const document = join(tmpdir(), `agentbrowse-contract-${process.pid}.json`);
  writeFileSync(document, emitted.stdout.toString());
  const checked = Bun.spawnSync(["bun", "run", validator, "--file", document], {
    stdout: "pipe",
    stderr: "pipe",
  });
  rmSync(document, { force: true });
  const output = `${checked.stdout.toString()}${checked.stderr.toString()}`;
  expect(output).toContain("conforms to version 1");
  expect(checked.exitCode).toBe(0);
});

test("every rendered surface is a render of the contract", () => {
  const help = renderHelp();
  for (const command of CONTRACT.commands) {
    expect(help).toContain(command.name);
    expect(help).toContain(command.summary);
  }
  for (const argument of CONTRACT.global_arguments) expect(help).toContain(argument.name);

  const runbook = renderAgentHelp();
  expect(runbook).toContain(CONTRACT.guidance);
  for (const entry of CONTRACT.concepts.error_codes) expect(runbook).toContain(entry.code);

  expect(renderTeaser().trim()).toBe(CONTRACT.meta.purpose);
});

test("the agent surfaces are reachable from argv", async () => {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    expect(await run(["--agent-teaser"])).toBe(0);
    expect(await run(["--agent-help"])).toBe(0);
    expect(await run(["guide"])).toBe(0);
  } finally {
    process.stdout.write = original;
  }
  expect(written[0]).toBe(renderTeaser());
  expect(written[1]).toBe(renderAgentHelp());
  expect(written[2]).toBe(renderAgentHelp());
});
