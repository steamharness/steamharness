import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectProjectScripts } from "../executor/rules";

test("entry validation treats generated database engines as dependencies while checking authored sources", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "database-entry-sources-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = path.join(root, ".steamharness/generated/database/node"); await mkdir(generated, { recursive: true });
  await writeFile(path.join(generated, "main.ts"), "export const database = {};\nconst Engine = 1;\nconst Engine = 2;\n");
  await writeFile(path.join(root, "helper.ts"), "export const helper = 1;\n");
  await writeFile(path.join(root, "index.ts"), `import { database } from "./.steamharness/generated/database/node/main.js";
import { helper } from "./helper.js";
const flow = steamharness.defineProject({ name: "test", async run(_input, context) { return { errCode: 0, errMessage: "" }; } });
export const executor = steamharness.defineExecutor({ projectType: "workflow", defaultEntrypoint: "run", entrypoints: [steamharness.defineEntrypoint({ id: "run", title: "Run", workflow: flow, createInput() { return {}; } })] });
`);
  const inspect = () => inspectProjectScripts({ cwd: root, projectDir: root, projectName: "test", entryFile: path.join(root, "index.ts") });
  assert.deepEqual(inspect().violations, []);
  assert.deepEqual(inspectProjectScripts({ cwd: root, projectDir: root, projectName: "test" }).violations, []);
  await writeFile(path.join(root, "helper.ts"), "export const helper = 1;\nconst helper = 2;\n");
  assert.ok(inspect().violations.some(violation => violation.type === "duplicate_script_declaration" && violation.name === "helper"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "database-entry-outside-")); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "main.ts"), "export const database = {};\n");
  await rm(path.join(generated, "main.ts"));
  await symlink(path.join(outside, "main.ts"), path.join(generated, "main.ts"));
  assert.throws(inspect, /escapes/);
});
