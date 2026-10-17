import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createCliRunPlan } from "../dev.mjs";

test("CLI development plan executes local CLI and Core sources", async () => {
  const root = path.resolve("checkout", "cli");
  const coreRoot = path.resolve("checkout", "core");
  const sharedRoot = path.resolve("checkout", "shared");
  const tsconfigPath = path.join(root, ".workflow-local", "tsconfig.json");
  const plan = await createCliRunPlan({
    root,
    env: {},
    branch: "dev",
    argv: ["help"],
    prepareDevelopment: async () => ({ coreRoot, sharedRoot, tsconfigPath }),
  });

  assert.equal(plan.mode, "dev");
  assert.equal(plan.build, undefined);
  assert.equal(plan.args.includes(path.join(root, "src", "index.ts")), true);
  assert.equal(plan.args.includes(tsconfigPath), true);
  assert.equal(plan.env.WORKFLOW_LOCAL_CORE_ROOT, coreRoot);
  assert.equal(plan.env.WORKFLOW_LOCAL_SHARED_ROOT, sharedRoot);
  assert.equal(plan.env.WORKFLOW_LOCAL_SOURCE_MODE, "1");
});

test("CLI main and tag plans build and execute dist without local source variables", async () => {
  for (const options of [
    {
      env: {
        NODE_OPTIONS: "--trace-warnings --conditions=development --enable-source-maps",
        TSX_TSCONFIG_PATH: "unsafe",
        WORKFLOW_LOCAL_SOURCE_MODE: "1",
      },
      branch: "main",
    },
    {
      env: {
        CI_COMMIT_TAG: "workflow-code-cli/v1.0.0",
        CI_COMMIT_BRANCH: "dev",
        NODE_OPTIONS: "--conditions development",
        WORKFLOW_LOCAL_CORE_ROOT: "unsafe",
      },
      branch: "dev",
    },
  ]) {
    const root = path.resolve("checkout", "cli");
    const plan = await createCliRunPlan({ root, ...options, argv: ["help"] });
    assert.equal(plan.mode, "main");
    assert.deepEqual(plan.build, ["pnpm", ["build"]]);
    assert.deepEqual(plan.args, [path.join(root, "dist", "index.js"), "help"]);
    assert.equal(plan.env.WORKFLOW_REPOSITORY_MODE, "main");
    assert.equal(plan.env.NODE_ENV, "production");
    assert.equal(plan.env.WORKFLOW_LOCAL_SOURCE_MODE, undefined);
    assert.equal(plan.env.WORKFLOW_LOCAL_CORE_ROOT, undefined);
    assert.equal(plan.env.WORKFLOW_LOCAL_SHARED_ROOT, undefined);
    assert.equal(plan.env.TSX_TSCONFIG_PATH, undefined);
    assert.equal(plan.env.NODE_OPTIONS?.includes("development") ?? false, false);
  }
});

test("CLI main plan preserves unrelated Node options", async () => {
  const plan = await createCliRunPlan({
    root: path.resolve("checkout", "cli"),
    env: { NODE_OPTIONS: "--trace-warnings --conditions=development --enable-source-maps" },
    branch: "main",
  });

  assert.equal(plan.env.NODE_OPTIONS, "--trace-warnings --enable-source-maps");
});
