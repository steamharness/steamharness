import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalProjectWithReport, runWorkspaceProjectWithReport } from "../executor/index";
import { LocalDatabaseRegistry, createLocalDatabaseResolver } from "../databases/index";

test("execution and nested entries share centralized IDs and respect environment overrides and host grants", async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "config-runtime-"));
  const directory = path.join(workspace, "workspace", "workflow", "configured");
  await mkdir(directory, {recursive:true});
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const projectId = randomUUID();
  const registry = new LocalDatabaseRegistry(path.join(directory, "registry"));
  const all = { mode: "all" as const };
  const permissions = { kv: { read: all, write: all }, knowledge: { read: all, write: all } };
  const spaces = ["First", "Replacement"].map(name => {
    const request = registry.request({ projectId, entryId: "one", alias: "data", permissions, target: { kind: "create", name } });
    const approved = registry.review(request.requestId, { approve: true });
    const shared = registry.request({ projectId, entryId: "two", alias: "data", permissions, target: { kind: "access", spaceId: approved.databaseId! } });
    registry.review(shared.requestId, { approve: true });
    return approved.databaseId!;
  });
  const restrictedRequest = registry.request({ projectId, entryId: "two", alias: "restricted", permissions, target: { kind: "create", name: "Only entry two" } });
  const restrictedId = registry.review(restrictedRequest.requestId, { approve: true }).databaseId!;
  const pkg = { id: projectId, name: "Config runtime", type: "module", steamHarness: { defaultEntry: "one", entries: ["one", "two"].map(entryId => ({ entryId, name: entryId, type: "workflow", root: ".", entry: "index.ts", databases: entryId === "one" ? ["data"] : ["data", "restricted"] })) } };
  await writeFile(path.join(directory, "package.json"), JSON.stringify(pkg));
  await writeFile(path.join(directory, "index.ts"), `
    const flow = steamharness.defineProject({ name: "Configured database", async run(input, context) {
      if (input.nested) return context.entries.get("two").runEntrypoint("read");
      const database = context.databases.get(input.restricted ? "restricted" : "data");
      await database.kv.setValue("last-entry", context.entryId);
      return { errCode: 0, errMessage: "", databaseId: (await database.getBinding()).space.spaceId, value: await database.kv.getValue("last-entry") };
    } });
    export const executor = steamharness.defineExecutor({ projectType: "workflow", defaultEntrypoint: "read", entrypoints: [steamharness.defineEntrypoint({id:"read",title:"Read",workflow:flow,createInput(context){return {nested:context.args.includes("nested"),restricted:context.args.includes("restricted")};}})] });
  `);
  const save = (databaseId: string) => writeFile(path.join(directory, "config.json"), JSON.stringify({ version: 1, databases: { data: databaseId, restricted: restrictedId } }));
  await save(spaces[0]!);
  const authored = await readFile(path.join(directory, "config.json"), "utf8");
  const run = async (expected: string, env: NodeJS.ProcessEnv = {}, nested = false) => {
    const report = await runLocalProjectWithReport({ projectDir: directory, databaseResolver: createLocalDatabaseResolver(registry), env, args: nested ? ["nested"] : [] });
    assert.equal(report.status, "success", JSON.stringify(report.result));
    if (report.result.ok) {
      assert.equal((report.result.data as any).output.databaseId, expected);
      assert.equal((report.result.data as any).output.value, nested ? "two" : "one");
    }
  };
  await run(spaces[0]!);
  await run(spaces[1]!, { STEAMHARNESS_PROJECT_CONFIG: JSON.stringify({ databases: { data: spaces[1] } }) }, true);
  assert.equal(await readFile(path.join(directory, "config.json"), "utf8"), authored);
  await save(spaces[1]!);
  await run(spaces[1]!, {}, true);
  const restricted = await runLocalProjectWithReport({ projectDir: directory, databaseResolver: createLocalDatabaseResolver(registry), args: ["restricted"] });
  assert.equal(restricted.status, "failed");
  assert.match(JSON.stringify(restricted.result), /not declared for entry/);
  const authorized = await runLocalProjectWithReport({ projectDir: directory, entryId: "two", databaseResolver: createLocalDatabaseResolver(registry), args: ["restricted"] });
  assert.equal(authorized.status, "success", JSON.stringify(authorized.result));
  const denied = await runLocalProjectWithReport({ projectDir: directory, databaseResolver: createLocalDatabaseResolver(registry), env: { STEAMHARNESS_PROJECT_CONFIG: JSON.stringify({ databases: { data: randomUUID() } }) } });
  assert.equal(denied.status, "failed");
  assert.match(JSON.stringify(denied.result), /host authorization/);
  // The configuration store and workspace discovery must also honor an environment-only mapping.
  await rm(path.join(directory, "config.json"));
  const env = { STEAMHARNESS_PROJECT_CONFIG: JSON.stringify({ databases: { data: spaces[0], restricted: restrictedId } }) };
  await run(spaces[0]!, env, true);
  const workspaceReport = await runWorkspaceProjectWithReport({ cwd: workspace, projectName: "configured", env, databaseResolver: createLocalDatabaseResolver(registry) });
  assert.equal(workspaceReport.status, "success", JSON.stringify(workspaceReport.result));
  assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), JSON.stringify(pkg));
});
