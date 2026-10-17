import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureSiblingInstalls, isSiblingPrepared, readSiblingManifest } from "../ensure-siblings.mjs";

function createRecorder() {
  const calls = [];
  return {
    calls,
    run: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
    },
  };
}

async function createSibling(parent, name, options = {}) {
  const siblingRoot = path.join(parent, name);
  await mkdir(siblingRoot, { recursive: true });
  await writeFile(path.join(siblingRoot, "package.json"), `${JSON.stringify({
    name: `@workflow-code/${name}-sibling`,
    ...(options.consumesShared === false ? {} : { scripts: { bootstrap: "node scripts/bootstrap.mjs" } }),
  })}\n`);
  if (options.installed !== false) await mkdir(path.join(siblingRoot, "node_modules"), { recursive: true });
  if (options.shared === "copied") {
    await mkdir(path.join(siblingRoot, ".shared", "i18n"), { recursive: true });
  }
  if (options.shared === "linked") {
    await mkdir(path.join(siblingRoot, ".shared"), { recursive: true });
    const source = path.join(parent, `${name}-linked-source`);
    await mkdir(source, { recursive: true });
    await symlink(source, path.join(siblingRoot, ".shared", "i18n"), process.platform === "win32" ? "junction" : "dir");
  }
  return siblingRoot;
}

async function createParent() {
  return mkdtemp(path.join(os.tmpdir(), "workflow-server-ensure-siblings-"));
}

test("prepared siblings are left alone", async () => {
  const parent = await createParent();
  const roots = await Promise.all([
    createSibling(parent, "core", { shared: "copied" }),
    createSibling(parent, "shared", { consumesShared: false }),
  ]);
  const recorder = createRecorder();

  const result = await ensureSiblingInstalls({ roots, env: {}, run: recorder.run, log: () => {} });

  assert.deepEqual(recorder.calls, []);
  assert.deepEqual(result, { installed: [], skipped: false });
});

test("a sibling without installed dependencies is bootstrapped", async () => {
  const parent = await createParent();
  const coreRoot = await createSibling(parent, "core", { installed: false, shared: "missing" });
  const recorder = createRecorder();
  const logged = [];

  const result = await ensureSiblingInstalls({
    roots: [coreRoot],
    env: {},
    run: recorder.run,
    log: (message) => logged.push(message),
  });

  assert.deepEqual(recorder.calls, [{ command: "pnpm", args: ["bootstrap"], cwd: coreRoot }]);
  assert.deepEqual(result.installed, [{ root: coreRoot, command: "pnpm", args: ["bootstrap"] }]);
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /core is not bootstrapped/);
});

test("installed dependencies with unprepared Shared packages are bootstrapped", async () => {
  const parent = await createParent();
  const coreRoot = await createSibling(parent, "core", { shared: "missing" });
  const recorder = createRecorder();

  await ensureSiblingInstalls({ roots: [coreRoot], env: {}, run: recorder.run, log: () => {} });

  assert.deepEqual(recorder.calls, [{ command: "pnpm", args: ["bootstrap"], cwd: coreRoot }]);
});

test("Shared source links count as unprepared", async () => {
  const parent = await createParent();
  const coreRoot = await createSibling(parent, "core", { shared: "linked" });
  const recorder = createRecorder();

  await ensureSiblingInstalls({ roots: [coreRoot], env: {}, run: recorder.run, log: () => {} });

  assert.deepEqual(recorder.calls, [{ command: "pnpm", args: ["bootstrap"], cwd: coreRoot }]);
});

test("a sibling that does not consume Shared packages is installed directly", async () => {
  const parent = await createParent();
  const sharedRoot = await createSibling(parent, "shared", { installed: false, consumesShared: false });
  const recorder = createRecorder();

  await ensureSiblingInstalls({ roots: [sharedRoot], env: {}, run: recorder.run, log: () => {} });

  assert.deepEqual(recorder.calls, [{ command: "pnpm", args: ["install"], cwd: sharedRoot }]);
});

test("Shared itself never needs a prepared .shared directory", async () => {
  const parent = await createParent();
  const sharedRoot = await createSibling(parent, "shared", { consumesShared: false });

  assert.equal(await isSiblingPrepared(sharedRoot, await readSiblingManifest(sharedRoot)), true);
});

test("the skip switch bypasses every check", async () => {
  const parent = await createParent();
  const coreRoot = await createSibling(parent, "core", { installed: false, shared: "missing" });
  const recorder = createRecorder();

  const result = await ensureSiblingInstalls({
    roots: [coreRoot],
    env: { WORKFLOW_SKIP_SIBLING_BOOTSTRAP: "1" },
    run: recorder.run,
    log: () => {},
  });

  assert.deepEqual(recorder.calls, []);
  assert.deepEqual(result, { installed: [], skipped: true });
});

test("siblings are repaired in dependency order", async () => {
  const parent = await createParent();
  const roots = await Promise.all([
    createSibling(parent, "shared", { installed: false, consumesShared: false }),
    createSibling(parent, "core", { installed: false, shared: "missing" }),
  ]);
  const recorder = createRecorder();

  await ensureSiblingInstalls({ roots, env: {}, run: recorder.run, log: () => {} });

  assert.deepEqual(recorder.calls.map((call) => path.basename(call.cwd)), ["shared", "core"]);
});

test("a missing sibling manifest names the repository instead of failing opaquely", async () => {
  const parent = await createParent();
  const missingRoot = path.join(parent, "absent");

  await assert.rejects(
    ensureSiblingInstalls({ roots: [missingRoot], env: {}, run: async () => {}, log: () => {} }),
    /Required sibling repository is missing package\.json/,
  );
});
