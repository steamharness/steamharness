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

test("workflow generator reads independent SDK and adjacent CLI versions without examples", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "workflow-core-generator-"));
  const target = path.join(temporaryRoot, "generated");

  try {
    const core = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const fixtureRoot = path.join(temporaryRoot, "core");
    const fixtureGenerator = path.join(fixtureRoot, ".agents/skills/steamharness-generator/scripts/create_workflow.py");
    await mkdir(path.dirname(fixtureGenerator), { recursive: true });
    await mkdir(path.join(temporaryRoot, "cli"));
    await copyFile(generator, fixtureGenerator);
    await writeProjectFixture(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: core.name, version: core.version }));
    const cliVersion = "7.8.9";
    await writeFile(path.join(temporaryRoot, "cli/package.json"), JSON.stringify({ name: "@steamharness/cli", version: cliVersion }));
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

test("workflow generator rejects missing, misidentified and non-exact adjacent CLI packages", async (t) => {
  for (const cli of [undefined, { name: "another-cli", version: "7.8.9" }, { name: "@steamharness/cli", version: "^7.8.9" }]) {
    await t.test(JSON.stringify(cli) ?? "missing CLI", async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "steamharness-generator-version-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const fixtureRoot = path.join(directory, "harness");
      const fixtureGenerator = path.join(fixtureRoot, "scripts/create_workflow.py");
      await mkdir(path.dirname(fixtureGenerator), { recursive: true });
      await copyFile(generator, fixtureGenerator);
      await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: "steamharness", version: "1.2.3" }));
      if (cli) {
        await mkdir(path.join(directory, "cli"));
        await writeFile(path.join(directory, "cli/package.json"), JSON.stringify(cli));
      }
      await assert.rejects(execFileAsync("python3", [fixtureGenerator, "invalid-version", "--dir", path.join(directory, "generated")]), /@steamharness\/cli.*SemVer/);
    });
  }
});

test("installed generator uses host dependencies instead of the host product version", async (t) => {
  for (const linked of [false, true]) {
    await t.test(linked ? "linked dependencies" : "exact dependencies", async (t) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "steamharness-generator-host-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const host = path.join(directory, "host"), target = path.join(directory, "generated");
      const fixtureGenerator = path.join(host, "skills/generator/scripts/create_workflow.py");
      await mkdir(path.dirname(fixtureGenerator), { recursive: true });
      await copyFile(generator, fixtureGenerator);
      if (linked) {
        for (const [folder, name, version] of [["harness", "steamharness", "1.2.3"], ["cli", "@steamharness/cli", "7.8.9"]]) {
          await mkdir(path.join(directory, folder));
          await writeFile(path.join(directory, folder, "package.json"), JSON.stringify({ name, version }));
        }
      }
      await writeFile(path.join(host, "package.json"), JSON.stringify({ name: "host", version: "99.0.0", devDependencies: {
        steamharness: linked ? "link:../harness" : "1.2.3", "@steamharness/cli": linked ? "link:../cli" : "7.8.9",
      } }));
      await execFileAsync("python3", [fixtureGenerator, "host-check", "--dir", target]);
      const generated = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
      assert.equal(generated.devDependencies.steamharness, "1.2.3");
      assert.equal(generated.devDependencies["@steamharness/cli"], "7.8.9");
    });
  }
});
