import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bundleAgentTypes } from "../bundle-agent-types.mjs";

test("bundled extension declarations resolve TypeScript specifiers and preserve distinct dependency versions", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-types-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const save = async (file, content) => {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
  };
  await save("package.json", JSON.stringify({ type: "module", dependencies: {} }));
  await save("dist/agent.d.ts", 'export type { One, Two } from "@earendil-works/fixture";');
  await save("node_modules/@earendil-works/fixture/package.json", JSON.stringify({ name: "@earendil-works/fixture", type: "module", exports: { ".": { types: "./index.d.ts" } } }));
  await save("node_modules/@earendil-works/fixture/index.d.ts", `
export type { Value as One } from "../../.pnpm/one/node_modules/same/index.ts";
export type Two = import("../../.pnpm/two/node_modules/same/index.ts").Value;
// @ts-ignore Optional SDK probing must not require installing every fetch implementation.
export type Optional = import("missing-optional-sdk").Value;
`);
  await save("node_modules/.pnpm/one/node_modules/same/index.d.ts", 'export interface Value { version: "one" }');
  await save("node_modules/.pnpm/two/node_modules/same/index.d.ts", 'export interface Value { version: "two" }');
  await bundleAgentTypes(path.join(directory, "dist"));
  await rm(path.join(directory, "node_modules"), { recursive: true });
  await save("consumer.ts", `
import type { One, Two } from "./dist/agent.js";
const first: One = { version: "one" };
const second: Two = { version: "two" };
// @ts-expect-error Separate versions must not overwrite each other's declarations.
const wrong: One = second;
void first; void wrong;
`);
  await save("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, noEmit: true, types: [] }, files: ["consumer.ts"] }));
  const tsc = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
  await promisify(execFile)(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: directory });
  const entry = await readFile(path.join(directory, "dist/agent.d.ts"), "utf8");
  await bundleAgentTypes(path.join(directory, "dist"));
  assert.equal(await readFile(path.join(directory, "dist/agent.d.ts"), "utf8"), entry);
  assert.equal((await readdir(path.join(directory, "dist/agent-types"))).length, 3);
});

test("missing required declaration dependencies fail the build", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-types-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "dist"));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ dependencies: {} }));
  await writeFile(path.join(directory, "dist/agent.d.ts"), 'export { Missing } from "@earendil-works/missing-required";');
  await assert.rejects(() => bundleAgentTypes(path.join(directory, "dist")), /Cannot bundle declaration module/);
});
