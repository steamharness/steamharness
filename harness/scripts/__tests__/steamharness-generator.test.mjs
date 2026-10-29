import { writeProjectFixture } from '../test-project-fixture.mjs';
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  "steamharness-generator",
  "scripts",
  "create_workflow.py",
);

test("workflow generator reads standalone Core and CLI versions", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-core-generator-"));
  const target = path.join(temporaryRoot, "generated");

  try {
    const core = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const fixtureRoot = path.join(temporaryRoot, "core");
    const fixtureGenerator = path.join(fixtureRoot, ".agents/skills/steamharness-generator/scripts/create_workflow.py");
    await mkdir(path.dirname(fixtureGenerator), { recursive: true });
    await mkdir(path.join(fixtureRoot, "workspace"));
    await copyFile(generator, fixtureGenerator);
    await writeProjectFixture(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: core.name, version: core.version }));
    // Standalone consumers declare a CLI version independently of the SDK.
    const cliVersion = "7.8.9";
    await writeProjectFixture(path.join(fixtureRoot, "workspace/package.json"), JSON.stringify({ devDependencies: { "@steamharness/cli": cliVersion } }));
    await execFileAsync("python3", [fixtureGenerator, "standalone-check", "--dir", target]);
    const generated = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    const outputTypes = await readFile(path.join(target, "interface.ts"), "utf8");
    assert.ok(outputTypes.includes('display?: OutputDisplay;'));
    assert.ok(outputTypes.includes('placement?: "inline" | "composer-right";'));
    assert.ok(outputTypes.includes('export interface RingContent'));
    assert.equal(generated.devDependencies["steamharness"], core.version);
    assert.equal(
      generated.devDependencies["@steamharness/cli"],
      cliVersion,
    );
    const project=JSON.parse(await readFile(path.join(target,"steamharness.json"),"utf8"));
    assert.equal(project.defaultEntry, "main");
    assert.equal(project.entries.length, 1);
    assert.deepEqual(project.entries[0], {
      entryId: "main", type: "workflow", name: "standalone-check", root: ".",
      entry: "index.ts", configuration: "configuration.json", databases: [],
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
