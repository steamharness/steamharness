import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServerRunPlan } from "../dev.mjs";

test("a fresh Server checkout reports bootstrap instructions before preparing sibling sources", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-server-uninstalled-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let preparedSiblings = false;
  for (const hotReload of [true, false]) {
    await assert.rejects(createServerRunPlan({
      root,
      env: {},
      branch: "codex/studio-integration",
      hotReload,
      prepareDevelopment: async () => { preparedSiblings = true; },
    }), (error) => {
      assert.match(error.message, /Server dependencies are missing.*Run pnpm bootstrap/);
      assert.equal(error.cause?.code, "MODULE_NOT_FOUND");
      return true;
    });
  }
  assert.equal(preparedSiblings, false);
});

test("Server development plan watches Server, Core, Shared, and Vite Web sources", async () => {
  const root = path.resolve("checkout", "server");
  const coreRoot = path.resolve("checkout", "core");
  const sharedRoot = path.resolve("checkout", "shared");
  const tsconfigPath = path.join(root, ".workflow-local", "tsconfig.json");
  const plan = await createServerRunPlan({
    root,
    env: {},
    branch: "dev",
    prepareDevelopment: async () => ({ coreRoot, sharedRoot, tsconfigPath }),
  });

  assert.equal(plan.mode, "dev");
  assert.equal(plan.hotReload, true);
  assert.equal(plan.build, undefined);
  assert.equal(plan.args.includes(path.join(root, "src", "index.ts")), true);
  assert.equal(plan.args.includes(path.join(coreRoot, "src")), true);
  assert.equal(plan.args.includes(sharedRoot), true);
  for (const dotGit of [path.join(coreRoot, ".git"), path.join(sharedRoot, ".git")]) {
    assert.equal(plan.args[plan.args.indexOf(dotGit) - 1], "--exclude");
  }
  assert.equal(plan.env.WORKFLOW_SERVER_DEV, "1");
  assert.equal(plan.env.WORKFLOW_SERVER_HMR, "1");
  assert.equal(plan.env.NODE_OPTIONS, "--conditions=development");
  assert.equal(plan.env.TSX_TSCONFIG_PATH, tsconfigPath);
  assert.equal(plan.env.WORKFLOW_LOCAL_SHARED_ROOT, sharedRoot);
  assert.equal(plan.env.WORKFLOW_LOCAL_SOURCE_MODE, "1");
});

test("Server start plan runs source without Server or Web hot reload", async () => {
  const root = path.resolve("checkout", "server");
  const coreRoot = path.resolve("checkout", "core");
  const sharedRoot = path.resolve("checkout", "shared");
  const tsconfigPath = path.join(root, ".workflow-local", "tsconfig.json");
  const plan = await createServerRunPlan({
    root,
    env: { WORKFLOW_SERVER_HMR: "1" },
    branch: "dev",
    hotReload: false,
    prepareDevelopment: async () => ({ coreRoot, sharedRoot, tsconfigPath }),
  });

  assert.equal(plan.hotReload, false);
  assert.equal(plan.args.includes("watch"), false);
  assert.equal(plan.args.includes("--clear-screen=false"), false);
  assert.equal(plan.args.includes("--include"), false);
  assert.equal(plan.args.includes("--tsconfig"), true);
  assert.equal(plan.args.at(-1), path.join(root, "src", "index.ts"));
  assert.equal(plan.env.WORKFLOW_SERVER_HMR, "0");
  assert.equal(plan.env.WORKFLOW_SERVER_DEV, "1");
});

test("Server main and tag plans build Server/Web and execute dist", async () => {
  for (const options of [
    {
      env: {
        NODE_OPTIONS: "--trace-warnings --conditions=development --enable-source-maps",
        TSX_TSCONFIG_PATH: "unsafe",
        WORKFLOW_LOCAL_SOURCE_MODE: "1",
        WORKFLOW_SERVER_DEV: "1",
        WORKFLOW_SERVER_HMR: "1",
      },
      branch: "main",
    },
    {
      env: {
        CI_COMMIT_TAG: "server/v1.0.0",
        CI_COMMIT_BRANCH: "dev",
        NODE_OPTIONS: "--conditions development",
        WORKFLOW_LOCAL_CORE_ROOT: "unsafe",
      },
      branch: "dev",
    },
  ]) {
    const root = path.resolve("checkout", "server");
    const plan = await createServerRunPlan({ root, ...options });
    assert.equal(plan.mode, "main");
    assert.equal(plan.hotReload, false);
    assert.deepEqual(plan.build, ["pnpm", ["build:all"]]);
    assert.deepEqual(plan.args, [path.join(root, "dist", "index.js")]);
    assert.equal(plan.env.WORKFLOW_REPOSITORY_MODE, "main");
    assert.equal(plan.env.WORKFLOW_SERVER_DEV, undefined);
    assert.equal(plan.env.WORKFLOW_SERVER_HMR, undefined);
    assert.equal(plan.env.WORKFLOW_LOCAL_SOURCE_MODE, undefined);
    assert.equal(plan.env.WORKFLOW_LOCAL_CORE_ROOT, undefined);
    assert.equal(plan.env.WORKFLOW_LOCAL_SHARED_ROOT, undefined);
    assert.equal(plan.env.TSX_TSCONFIG_PATH, undefined);
    assert.equal(plan.env.NODE_OPTIONS?.includes("development") ?? false, false);
  }
});

test("Server main plan preserves unrelated Node options", async () => {
  const plan = await createServerRunPlan({
    root: path.resolve("checkout", "server"),
    env: { NODE_OPTIONS: "--trace-warnings --conditions=development --enable-source-maps" },
    branch: "main",
  });

  assert.equal(plan.env.NODE_OPTIONS, "--trace-warnings --enable-source-maps");
});

test("Server development plan preserves Node options and adds the development condition once", async () => {
  const root = path.resolve("checkout", "server");
  const coreRoot = path.resolve("checkout", "core");
  const sharedRoot = path.resolve("checkout", "shared");
  const plan = await createServerRunPlan({
    root,
    env: { NODE_OPTIONS: "--trace-warnings --conditions=development" },
    branch: "dev",
    prepareDevelopment: async () => ({
      coreRoot,
      sharedRoot,
      tsconfigPath: path.join(root, ".workflow-local", "tsconfig.json"),
    }),
  });

  assert.equal(plan.env.NODE_OPTIONS, "--trace-warnings --conditions=development");
});
