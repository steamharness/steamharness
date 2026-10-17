import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

// `pnpm test` builds first, so the entry this test spawns is the built one.
const builtEntry = path.resolve(import.meta.dirname, "../../dist/index.js");

const execFileAsync = promisify(execFile);

async function runEntry(entryPath: string, args: string[] = ["--help"]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [entryPath, ...args], { encoding: "utf8" });
  return stdout;
}

// A package manager that links packages into a store reaches the entry through
// a symlink, and Node resolves ESM module URLs to the real path. Comparing only
// the unresolved path left the CLI printing nothing at exit code 0 — a silent
// no-op that reads as a passing check.
it("runs when the entry is reached through a symlink", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "steamharness-cli-entry-"));
  const linkedEntry = path.join(directory, "steamharness.js");
  try {
    await symlink(builtEntry, linkedEntry);
    assert.match(await runEntry(linkedEntry), /structure/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("runs when the entry is invoked by its real path", async () => {
  assert.match(await runEntry(builtEntry), /structure/);
});

// The guard exists so that importing the module — a test, an embedding host —
// does not run the CLI. The extra argument stands in for the entry path such a
// process reports, which is never this module.
it("stays out of the way when the module is imported", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(builtEntry).href)});`,
    path.join(os.tmpdir(), "not-the-cli-entry.js"),
  ], { encoding: "utf8" });
  assert.equal(stdout, "");
});
