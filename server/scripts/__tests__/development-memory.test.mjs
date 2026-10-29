import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadDevelopmentEnvironment, shouldStartDevelopmentMemory, startDevelopmentMemory } from "../development-memory.mjs";

const helperUrl = new URL("../development-memory.mjs", import.meta.url).href;
const memoryRoot = fileURLToPath(new URL("../../../memory-service", import.meta.url));
const env = () => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, STEAMHARNESS_SKIP_ENV_FILES: "1" });

async function temporaryRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "steamharness-dev-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(40);
  }
  throw new Error("Development runtime did not become ready.");
}

async function assertStopped(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch(`${url}/health`, { signal: AbortSignal.timeout(200) }); } catch { return; }
    await delay(30);
  }
  assert.fail("Local memory service was left running.");
}

test("development env respects inherited values, redirected roots, and skip-env isolation", async (t) => {
  const root = await temporaryRoot(t);
  const redirected = path.join(root, "data-root");
  await mkdir(redirected);
  await writeFile(path.join(root, ".env"), "STEAMHARNESS_REPO_ROOT=data-root\nSTEAMHARNESS_SERVER_MEMORY_AUTOSTART=0\nORIGINAL=file\n");
  await writeFile(path.join(redirected, ".env"), "ADDITIONAL=loaded\nORIGINAL=redirected\n");
  const inherited = { ORIGINAL: "shell" };
  assert.deepEqual(loadDevelopmentEnvironment({ root, env: inherited }), {
    ORIGINAL: "shell", STEAMHARNESS_REPO_ROOT: "data-root", STEAMHARNESS_SERVER_MEMORY_AUTOSTART: "0", ADDITIONAL: "loaded",
  });
  assert.deepEqual(inherited, { ORIGINAL: "shell" });
  assert.deepEqual(loadDevelopmentEnvironment({ root, env: { STEAMHARNESS_SKIP_ENV_FILES: "1" } }), { STEAMHARNESS_SKIP_ENV_FILES: "1" });
});

test("autostart is default, with independent disable and external-service overrides", () => {
  assert.equal(shouldStartDevelopmentMemory({}), true);
  assert.equal(shouldStartDevelopmentMemory({ STEAMHARNESS_SERVER_MEMORY_URL: " " }), true);
  for (const disabled of [
    { STEAMHARNESS_SERVER_MEMORY_AUTOSTART: "0" },
    { STEAMHARNESS_SERVER_MEMORY_DISABLED: "1" },
    { STEAMHARNESS_SERVER_MEMORY_URL: "http://127.0.0.1:7141" },
  ]) assert.equal(shouldStartDevelopmentMemory(disabled), false);
});

test("real local services have separate ports and persistent Server-owned SQLite storage", async (t) => {
  const root = await temporaryRoot(t);
  const logs = [];
  let first = await startDevelopmentMemory({ root, env: env(), log: (line) => logs.push(line) });
  t.after(() => first.stop());
  const second = await startDevelopmentMemory({
    root: path.join(root, "internal"),
    env: { ...env(), STEAMHARNESS_REPO_ROOT: "redirected", STEAMHARNESS_SERVER_DATA_DIR: "custom-data" },
    log: () => {},
  });
  t.after(() => second.stop());
  assert.notEqual(first.env.STEAMHARNESS_SERVER_MEMORY_URL, second.env.STEAMHARNESS_SERVER_MEMORY_URL);
  assert.notEqual(first.env.STEAMHARNESS_SERVER_MEMORY_TOKEN, second.env.STEAMHARNESS_SERVER_MEMORY_TOKEN);
  assert.ok((await readdir(path.join(root, ".data/memory"))).length > 0);
  assert.ok((await readdir(path.join(root, "internal/custom-data/memory"))).length > 0);
  assert.equal(logs.join("\n").includes(first.env.STEAMHARNESS_SERVER_MEMORY_TOKEN), false);
  const call = async (service, body) => {
    const response = await fetch(`${service.env.STEAMHARNESS_SERVER_MEMORY_URL}/v1/call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${service.env.STEAMHARNESS_SERVER_MEMORY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ account: "test-account", ...body }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  await call(first, { method: "apply", operation: {
    operationId: "manual-stable-id", action: "remember", scope: "global", content: "偏好中文回答；prefer concise responses.",
  } });
  const other = await call(second, { method: "list", scopes: ["global"] });
  assert.equal(other.items.length, 0);
  const previousUrl = first.env.STEAMHARNESS_SERVER_MEMORY_URL;
  await first.stop();
  await assertStopped(previousUrl);
  first = await startDevelopmentMemory({ root, env: env(), log: () => {} });
  const recalled = await call(first, { method: "recall", scopes: ["global"], query: "中文 concise" });
  assert.equal(recalled.length, 1);
  assert.match(recalled[0].content, /偏好中文/);
  const unauthorized = await fetch(`${first.env.STEAMHARNESS_SERVER_MEMORY_URL}/health`);
  assert.equal(unauthorized.status, 401);
});

async function launchSupervisor(t, extraEnv = {}, { exitCode = 0, hold = false } = {}) {
  const root = await temporaryRoot(t);
  const statusFile = path.join(root, "runtime.json");
  const runtime = path.join(root, "runtime.mjs");
  await writeFile(runtime, `
    import { writeFile } from 'node:fs/promises';
    const url = process.env.STEAMHARNESS_SERVER_MEMORY_URL;
    let healthy = false;
    if (url) {
      const response = await fetch(url + '/health', {headers: {Authorization: 'Bearer ' + process.env.STEAMHARNESS_SERVER_MEMORY_TOKEN}});
      healthy = response.ok && (await response.json()).fts === true;
    }
    await writeFile(${JSON.stringify(statusFile)}, JSON.stringify({url, healthy}));
    ${hold ? "setInterval(() => {}, 1000);" : `process.exitCode = ${exitCode};`}
  `);
  const supervisor = path.join(root, "supervisor.mjs");
  await writeFile(supervisor, `
    import { runDevelopmentServer } from ${JSON.stringify(helperUrl)};
    process.exitCode = await runDevelopmentServer({
      root: ${JSON.stringify(root)}, memoryRoot: ${JSON.stringify(memoryRoot)},
      command: process.execPath, args: [${JSON.stringify(runtime)}],
    });
  `);
  const child = spawn(process.execPath, [supervisor], { env: { ...env(), ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "exit");
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  });
  return { child, closed, statusFile, output: () => output };
}

test("the supervisor waits for health, preserves Server exit status and stops memory", async (t) => {
  const { closed, statusFile } = await launchSupervisor(t, {}, { exitCode: 23 });
  const status = await waitForFile(statusFile);
  assert.equal(status.healthy, true);
  assert.deepEqual(await closed, [23, null]);
  await assertStopped(status.url);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`the supervisor forwards ${signal} and removes the managed service`, { skip: process.platform === "win32" }, async (t) => {
    const { child, closed, statusFile } = await launchSupervisor(t, {}, { hold: true });
    const status = await waitForFile(statusFile);
    assert.equal(status.healthy, true);
    child.kill(signal);
    assert.deepEqual(await closed, [signal === "SIGINT" ? 130 : 143, null]);
    await assertStopped(status.url);
  });
}

test("disabled memory never starts a service and startup failure does not block Server", async (t) => {
  for (const extraEnv of [
    { STEAMHARNESS_SERVER_MEMORY_AUTOSTART: "0" },
    { STEAMHARNESS_SERVER_MEMORY_DISABLED: "1" },
    { STEAMHARNESS_SERVER_MEMORY_TOKEN: "invalid-test-only-short-token" },
  ]) {
    const { closed, statusFile, output } = await launchSupervisor(t, extraEnv);
    assert.deepEqual(await closed, [0, null]);
    assert.deepEqual(await waitForFile(statusFile), { healthy: false });
    if (extraEnv.STEAMHARNESS_SERVER_MEMORY_TOKEN) {
      assert.match(output(), /Server will continue without local memory/);
      assert.equal(output().includes(extraEnv.STEAMHARNESS_SERVER_MEMORY_TOKEN), false);
    }
  }
});

test("an explicit external service is reused and survives the Server supervisor", async (t) => {
  const root = await temporaryRoot(t);
  const external = await startDevelopmentMemory({ root, env: env(), log: () => {} });
  t.after(() => external.stop());
  const url = external.env.STEAMHARNESS_SERVER_MEMORY_URL;
  const token = external.env.STEAMHARNESS_SERVER_MEMORY_TOKEN;
  const { closed, statusFile, output } = await launchSupervisor(t, {
    STEAMHARNESS_SERVER_MEMORY_URL: url,
    STEAMHARNESS_SERVER_MEMORY_TOKEN: token,
  });
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual(await waitForFile(statusFile), { url, healthy: true });
  assert.equal(output().includes("Local service ready"), false);
  const response = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  // A pinned port cannot silently attach Server to an unrelated live service.
  const busy = await launchSupervisor(t, { STEAMHARNESS_MEMORY_PORT: new URL(url).port });
  assert.deepEqual(await busy.closed, [0, null]);
  assert.deepEqual(await waitForFile(busy.statusFile), { healthy: false });
  assert.match(busy.output(), /exited before it was ready/);
  assert.equal((await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});

test("startup cancellation and readiness timeout clean up without waiting indefinitely", async (t) => {
  const root = await temporaryRoot(t);
  await assert.rejects(startDevelopmentMemory({ root, env: env(), readyTimeout: 1, log: () => {} }), /readiness timed out/);
  const controller = new AbortController();
  const starting = startDevelopmentMemory({ root, env: env(), signal: controller.signal, log: () => {} });
  controller.abort();
  await assert.rejects(starting, /startup was stopped|exited before/);
});

test("a killed supervisor disconnects IPC and the real memory service exits", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const statusFile = path.join(root, "memory.json");
  const launcher = path.join(root, "launcher.mjs");
  await writeFile(launcher, `
    import { startDevelopmentMemory } from ${JSON.stringify(helperUrl)};
    import { writeFile } from 'node:fs/promises';
    const service = await startDevelopmentMemory({ root: ${JSON.stringify(root)}, memoryRoot: ${JSON.stringify(memoryRoot)}, log: () => {} });
    await writeFile(${JSON.stringify(statusFile)}, JSON.stringify({ url: service.env.STEAMHARNESS_SERVER_MEMORY_URL }));
    await service.closed;
  `);
  const child = spawn(process.execPath, [launcher], { env: env(), stdio: "ignore" });
  const closed = once(child, "exit");
  t.after(async () => { child.kill("SIGKILL"); await closed; });
  const { url } = await waitForFile(statusFile);
  child.kill("SIGKILL");
  await closed;
  await assertStopped(url);
});
