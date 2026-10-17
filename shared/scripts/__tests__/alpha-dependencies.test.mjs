import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  groupDependencyTargets,
  parseDependencyTarget,
  prepareTargetWorkspace,
  synchronizeAlphaDependencies,
  updateExactDependency,
} from "../../release-tools/alpha-dependencies.mjs";

test("dependency target parsing keeps project, manifest and dependency section explicit", () => {
  assert.deepEqual(parseDependencyTarget("workflow/server|package.json|devDependencies"), {
    project: "workflow/server",
    manifestPath: "package.json",
    section: "devDependencies",
  });
  assert.throws(() => parseDependencyTarget("workflow/server|package.json|optionalDependencies"), /Invalid dependency target/);
  assert.throws(() => parseDependencyTarget("../server|package.json|dependencies"), /target project/);
  assert.throws(() => parseDependencyTarget("workflow/server|../package.json|dependencies"), /target manifest/);
});

test("dependency targets for one repository are grouped into one synchronization commit", () => {
  const targets = [
    parseDependencyTarget("workflow/cli|package.json|devDependencies"),
    parseDependencyTarget("workflow/cli|package.json|peerDependencies"),
    parseDependencyTarget("workflow/server|package.json|dependencies"),
  ];
  assert.deepEqual([...groupDependencyTargets(targets).keys()], ["workflow/cli", "workflow/server"]);
  assert.deepEqual(groupDependencyTargets(targets).get("workflow/cli")?.map((target) => target.section), [
    "devDependencies",
    "peerDependencies",
  ]);
});

test("dependency synchronization writes an exact alpha version and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-alpha-dependency-test-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      dependencies: { "workflow-code": "0.1.3" },
    }));
    assert.equal(await updateExactDependency({
      root,
      section: "dependencies",
      dependency: "workflow-code",
      version: "0.1.4-20260814001",
    }), true);
    assert.equal(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).dependencies["workflow-code"], "0.1.4-20260814001");
    assert.equal(await updateExactDependency({
      root,
      section: "dependencies",
      dependency: "workflow-code",
      version: "0.1.4-20260814001",
    }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency workspace preparation prefers the repository sibling bootstrap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-alpha-dependency-prepare-test-"));
  try {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "scripts", "prepare-siblings.mjs"), ""),
      writeFile(path.join(root, "scripts", "prepare-shared.mjs"), ""),
    ]);
    const commands = [];
    const selected = await prepareTargetWorkspace({
      root,
      runCommand: async (command, args, options) => commands.push({ command, args, options }),
    });
    assert.equal(selected, "scripts/prepare-siblings.mjs");
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command, process.execPath);
    assert.deepEqual(commands[0].args, ["scripts/prepare-siblings.mjs"]);
    assert.equal(commands[0].options.cwd, root);
    assert.equal(commands[0].options.env.WORKFLOW_REPOSITORY_MODE, "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency synchronization captures push failures and retries a non-fast-forward update", async () => {
  let pushAttempts = 0;
  const commands = [];
  const result = await synchronizeAlphaDependencies({
    dependency: "workflow-code",
    version: "0.1.4-20260814001",
    targets: ["workflow/server|package.json|dependencies"],
    message: "chore: update Core alpha dependency",
    serverUrl: "http://yuhe.space:7201",
    token: "secret-sync-token",
    skipCi: true,
    attempts: 2,
    runCommand: async (command, args, options) => {
      commands.push({ command, args });
      if (args.includes("clone")) {
        const checkout = args.at(-1);
        await mkdir(path.join(checkout, "scripts"), { recursive: true });
        await writeFile(path.join(checkout, "package.json"), JSON.stringify({
          dependencies: { "workflow-code": "0.1.3" },
        }));
        await writeFile(path.join(checkout, "scripts", "prepare-shared.mjs"), "");
      }
      if (args.includes("push")) {
        pushAttempts += 1;
        assert.equal(options.capture, true);
        assert.deepEqual(args.slice(0, 4), ["push", "-o", "ci.skip", "origin"]);
        if (pushAttempts === 1) throw new Error("git push exited 1: non-fast-forward");
      }
      return "";
    },
  });
  assert.equal(pushAttempts, 2);
  assert.deepEqual(result.map((entry) => entry.project), ["workflow/server"]);
  const preparationIndex = commands.findIndex(({ command, args }) => command === process.execPath && args[0] === "scripts/prepare-shared.mjs");
  const installIndex = commands.findIndex(({ command, args }) => command === "corepack" && args.includes("--lockfile-only"));
  assert.ok(preparationIndex >= 0);
  assert.ok(installIndex > preparationIndex);
});
