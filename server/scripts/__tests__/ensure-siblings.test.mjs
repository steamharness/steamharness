import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  await writeFile(path.join(siblingRoot, "package.json"), `${JSON.stringify({ name: `@steamharness/${name}-sibling` })}\n`);
  if (options.installed !== false) await mkdir(path.join(siblingRoot, "node_modules"), { recursive: true });
  return siblingRoot;
}

async function createParent() {
  return mkdtemp(path.join(os.tmpdir(), "steamharness-server-ensure-siblings-"));
}

test("installed siblings are left alone", async () => {
  const parent = await createParent();
  const roots = await Promise.all([
    createSibling(parent, "harness"),
    createSibling(parent, "shared"),
  ]);
  const recorder = createRecorder();

  const result = await ensureSiblingInstalls({ roots, env: {}, run: recorder.run, log: () => {} });

  assert.deepEqual(recorder.calls, []);
  assert.deepEqual(result, { installed: [], skipped: false });
});

test("a sibling without installed dependencies is installed", async () => {
  const parent = await createParent();
  const harnessRoot = await createSibling(parent, "harness", { installed: false });
  const recorder = createRecorder();
  const logged = [];

  const result = await ensureSiblingInstalls({
    roots: [harnessRoot],
    env: {},
    run: recorder.run,
    log: (message) => logged.push(message),
  });

  assert.deepEqual(recorder.calls, [{ command: "pnpm", args: ["install"], cwd: harnessRoot }]);
  assert.deepEqual(result.installed, [{ root: harnessRoot, command: "pnpm", args: ["install"] }]);
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /harness is not bootstrapped/);
});

test("Shared is prepared exactly like any other sibling", async () => {
  const parent = await createParent();
  const sharedRoot = await createSibling(parent, "shared", { installed: false });
  const recorder = createRecorder();

  await ensureSiblingInstalls({ roots: [sharedRoot], env: {}, run: recorder.run, log: () => {} });

  assert.deepEqual(recorder.calls, [{ command: "pnpm", args: ["install"], cwd: sharedRoot }]);
});

test("the skip switch bypasses every check", async () => {
  const parent = await createParent();
  const harnessRoot = await createSibling(parent, "harness", { installed: false });
  const recorder = createRecorder();

  const result = await ensureSiblingInstalls({
    roots: [harnessRoot],
    env: { STEAMHARNESS_SKIP_SIBLING_BOOTSTRAP: "1" },
    run: recorder.run,
    log: () => {},
  });

  assert.deepEqual(recorder.calls, []);
  assert.deepEqual(result, { installed: [], skipped: true });
});

test("siblings are repaired in dependency order", async () => {
  const parent = await createParent();
  const roots = await Promise.all([
    createSibling(parent, "shared", { installed: false }),
    createSibling(parent, "harness", { installed: false }),
  ]);
  const recorder = createRecorder();

  await ensureSiblingInstalls({ roots, env: {}, run: recorder.run, log: () => {} });

  assert.deepEqual(recorder.calls.map((call) => path.basename(call.cwd)), ["shared", "harness"]);
});

test("a missing sibling manifest names the repository instead of failing opaquely", async () => {
  const parent = await createParent();
  const missingRoot = path.join(parent, "absent");

  await assert.rejects(
    ensureSiblingInstalls({ roots: [missingRoot], env: {}, run: async () => {}, log: () => {} }),
    /Required sibling repository is missing package\.json/,
  );
});

test("isSiblingPrepared only reports installed dependencies", async () => {
  const parent = await createParent();
  const installed = await createSibling(parent, "harness");
  const missing = await createSibling(parent, "cli", { installed: false });

  assert.equal(isSiblingPrepared(installed), true);
  assert.equal(isSiblingPrepared(missing), false);
  assert.equal((await readSiblingManifest(installed)).name, "@steamharness/harness-sibling");
});
