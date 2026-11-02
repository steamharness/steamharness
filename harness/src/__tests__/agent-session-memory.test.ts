import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

for (const mode of ["node", "project"]) test(`long-lived Agent ${mode} streams keep the latest snapshot under a 128 MB heap`, { timeout: 30_000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=128", "--import", "tsx", "--conditions=development",
    path.join(import.meta.dirname, "fixtures/agent-session-memory.ts"), mode], { timeout: 25_000 });
  assert.deepEqual(JSON.parse(stdout.trim()), { frames: 1212, items: 7, revision: 599 });
});
