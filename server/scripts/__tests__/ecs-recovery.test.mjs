import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parseImmutableRef } from "../recover-ecs-artifact.mjs";
import { validateMigrationId } from "../migrate-ecs.mjs";

const exec = promisify(execFile);
const agentPath = path.resolve(import.meta.dirname, "../../docker/ecs/ecs-runtime-agent.sh");

test("recovery accepts immutable release tags only", () => {
  assert.deepEqual(parseImmutableRef("server-web/v0.1.6"), { channel: "stable", version: "0.1.6" });
  assert.deepEqual(parseImmutableRef("alpha/v0.1.10-20260910004"), { channel: "alpha", version: "0.1.10-20260910004" });
  for (const value of ["dev", "alpha", "alpha/v0.1.10", "server-web/v0.1.6-20260910001"]) assert.throws(() => parseImmutableRef(value));
  for (const value of ["", "../backup", "a;touch x"]) assert.throws(() => validateMigrationId(value));
});

test("ensure starts a missing service without restarting an active service or recreating containers", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ecs-recovery-test-"));
  try {
    const source = (await readFile(agentPath, "utf8")).split('command="${1:-}"')[0];
    const script = path.join(temp, "test.sh");
    await writeFile(script, `${source}\nensure_docker() { :; }\ncompose() { printf 'compose %s\\n' "$*"; }\nsystemctl() { if [[ "$*" == 'is-active --quiet running.service' ]]; then return 0; elif [[ "$1" == is-active ]]; then return 1; else printf 'systemctl %s\\n' "$*"; fi; }\nensure_compose\nstart_unit running\nstart_unit stopped\n`);
    const { stdout } = await exec("bash", [script]);
    assert.match(stdout, /up --detach --no-recreate --pull never --wait/u);
    assert.match(stdout, /systemctl start stopped.service/u);
    assert.doesNotMatch(stdout, /restart|down|systemctl start running/u);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test("ECS legacy runtime binds its listener to loopback", async () => {
  const preload = path.resolve(import.meta.dirname, "../../docker/ecs/loopback.mjs");
  const code = 'const s = require("node:net").createServer(); s.listen(0, () => { console.log(s.address().address); s.close(); });';
  const { stdout } = await exec(process.execPath, ["--import", preload, "-e", code], { env: { ...process.env, STEAMHARNESS_SERVER_PORT: "0" } });
  assert.equal(stdout.trim(), "127.0.0.1");
});
