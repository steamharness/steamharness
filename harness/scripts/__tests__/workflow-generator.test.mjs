import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..", "..");
const generator = path.join(
  root,
  ".agents",
  "skills",
  "workflow-generator",
  "scripts",
  "create_workflow.py",
);

test("workflow generator reads standalone Core and CLI versions", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-core-generator-"));
  const target = path.join(temporaryRoot, "generated");

  try {
    await execFileAsync("python3", [generator, "standalone-check", "--dir", target]);
    const generated = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    const outputTypes = await readFile(path.join(target, "interface.ts"), "utf8");
    assert.ok(outputTypes.includes('display?: OutputDisplay;'));
    assert.ok(outputTypes.includes('placement?: "inline" | "composer-right";'));
    assert.ok(outputTypes.includes('export interface RingContent'));
    const core = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const workspace = JSON.parse(await readFile(path.join(root, "workspace", "package.json"), "utf8"));

    assert.equal(generated.devDependencies["steamharness"], core.version);
    assert.equal(
      generated.devDependencies["@steamharness/cli"],
      workspace.devDependencies["@steamharness/cli"],
    );
    assert.equal(generated.steamHarness.projectInfo.dataStorage.mode, "both");
    assert.deepEqual(generated.steamHarness.projectInfo.relatedProjects, []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
