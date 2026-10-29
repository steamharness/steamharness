import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectAggregateProjectStructure, inspectLocalProjectStructure, runLocalProjectWithReport } from "../executor/index";
import { createLocalProjectConfigurationStore } from "../configuration";
import { LocalDatabaseRegistry, createLocalDatabaseResolver } from "../databases/index";
import { createProjectToolPermissionContext } from "../tool-permissions/index";
import { createEntriesContext } from "../entries/index";

test("a child operation signal stops only its entry call while the parent signal still fences every call", async () => {
  const parent = new AbortController(), child = new AbortController(); const signals: AbortSignal[] = [];
  const entries = createEntriesContext({ projectId: randomUUID(), name: "test", defaultEntry: "one", entries: [{ entryId: "one", name: "one", type: "workflow", root: ".", entry: "one.ts", databases: [] }] },
    { actor: { userId: "alice", isSystemAdmin: false }, projectId: "project", sourceEntryId: "one", abortSignal: parent.signal },
    { list: async () => [], run: async (_entry, _operation, _args, identity) => { assert.equal(identity.actor.userId, "alice"); signals.push(identity.abortSignal!); return {}; } });
  await entries.get("one").runEntrypoint("read", [], { abortSignal: child.signal });
  child.abort(new Error("Work stopped")); assert.equal(signals[0].aborted, true); assert.equal(parent.signal.aborted, false);
  await entries.get("one").runEntrypoint("read"); assert.equal(signals[1].aborted, false);
  parent.abort(new Error("Host stopped")); assert.equal(signals[1].aborted, true);
  await assert.rejects(entries.get("one").runEntrypoint("read", [], { abortSignal: new AbortController().signal }), /Host stopped/);
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aggregate-entries-"));
  const projectId = randomUUID();
  const entries = ["one", "two", "chat", "board"].map((entryId) => ({ entryId, name: entryId, type: entryId === "chat" ? "conversation" : entryId === "board" ? "kanban" : "workflow", root: ".", entry: `${entryId}.${entryId === "board" ? "html" : "ts"}`, databases: [], configuration: `${entryId}.json` }));
  await writeProjectFixture(path.join(directory, "package.json"), JSON.stringify({ id: projectId, name: "aggregate-test", type: "module", version: "0.1.0",  entries, defaultEntry: "one"  }));
  for (const entry of entries) {
    await writeFile(path.join(directory, entry.configuration), JSON.stringify({ version: 1, fields: [{ name: "label", label: "Label", type: "string", defaultValue: entry.entryId }] }));
    if (entry.type === "kanban") { await writeFile(path.join(directory, entry.entry), "<!doctype html><title>Board</title>"); continue; }
    const workflow = `const flow = steamharness.defineProject({ name: "${entry.entryId}", async run(input, context) {
      if (input.nested) return context.entries.get("two").runEntrypoint("read");
      return { errCode: 0, errMessage: "", entryId: context.metadata.entryId, label: context.config.label, actor: context.actor };
    }});`;
    const executor = entry.type === "conversation" ? 'projectType: "conversation", workflow: flow, createInput() { return {}; }' : 'projectType: "workflow", defaultEntrypoint: "read", entrypoints: [steamharness.defineEntrypoint({ id: "read", title: "Read", workflow: flow, createInput(context) { return { nested: context.args.includes("nested") }; } })]';
    await writeFile(path.join(directory, entry.entry), `${workflow}\nexport const executor = steamharness.defineExecutor({ ${executor} });`);
  }
  return { directory, projectId };
}

test("registered modules isolate static analysis even when all entries share a code root", async () => {
  const { directory, projectId } = await fixture();
  try {
    const structures = inspectAggregateProjectStructure(directory);
    assert.equal(structures.projectId, projectId);
    assert.deepEqual(structures.entries.map((entry) => entry.projectType), ["workflow", "workflow", "conversation", "kanban"]);
    assert.equal(inspectLocalProjectStructure({ projectDir: directory }).entryId, "one");
    const events: any[] = [];
    const report = await runLocalProjectWithReport({ projectDir: directory, entryId: "two", onRuntimeEvent: event => { events.push(event); }, actor: { userId: "caller", isSystemAdmin: false } });
    assert.equal(report.result.ok, true, JSON.stringify(report.result));
    assert.equal(report.entryId, "two");
    assert.equal(report.projectId, projectId);
    assert.ok(events.length > 0 && events.every(event => event.projectId === projectId && event.entryId === "two"));
    if (report.result.ok) assert.equal((report.result.data as any).output.entryId, "two");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("entry configuration identities differ and nested calls load target configuration and preserve the caller", async () => {
  const { directory } = await fixture();
  try {
    const one = await createLocalProjectConfigurationStore(directory, { entryId: "one" });
    const two = await createLocalProjectConfigurationStore(directory, { entryId: "two" });
    const a = await one.read(), b = await two.read();
    assert.equal(a.fields[0]?.name, b.fields[0]?.name);
    assert.notDeepEqual(a.configurations, b.configurations);
    const calls: string[] = [];
    const report = await runLocalProjectWithReport({ projectDir: directory, entryId: "one", args: ["nested"], actor: { userId: "alice", isSystemAdmin: false }, authorizeEntry(entryId, operation, actor) { calls.push(`${entryId}:${operation}:${actor.userId}`); } });
    assert.equal(report.result.ok, true, JSON.stringify(report.result));
    assert.deepEqual(calls, ["two:read:alice"]);
    if (report.result.ok) assert.deepEqual({ ...(report.result.data as any).output, items: undefined }, { errCode: 0, errMessage: "", entryId: "two", label: "two", actor: { userId: "alice", isSystemAdmin: false }, items: undefined });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("entry operations use target grants while rechecking the caller and inherited tool restrictions", async () => {
  const { directory, projectId } = await fixture();
  try {
    const registry = new LocalDatabaseRegistry(path.join(directory, "registry"));
    const all = { mode: "all" as const };
    const permissions = { kv: { read: all, write: all }, knowledge: { read: all, write: all } };
    const request = registry.request({ projectId, entryId: "two", alias: "cache", target: { kind: "create", name: "Target cache" }, permissions });
    const approval = registry.review(request.requestId, { approve: true });
    await writeFile(path.join(directory, "config.json"), JSON.stringify({ version: 1, databases: { cache: approval.databaseId } }));
    const pkg = JSON.parse(await readFile(path.join(directory, "steamharness.json"), "utf8"));
    pkg.entries.find((entry: {entryId: string}) => entry.entryId === "two").databases = ["cache"];
    await writeFile(path.join(directory, "steamharness.json"), JSON.stringify(pkg));
    await writeFile(path.join(directory, "two.ts"), `const flow = steamharness.defineProject({ name: "Cache", async run(_input, context) {
      await context.databases.get("cache").kv.setValue("cached", context.actor.userId);
      return { errCode: 0, errMessage: "", actor: context.actor, value: await context.databases.get("cache").kv.getValue("cached") };
    }});
    export const executor = steamharness.defineExecutor({ projectType: "workflow", defaultEntrypoint: "read", entrypoints: [steamharness.defineEntrypoint({ id: "read", title: "Cache", workflow: flow, createInput() { return {}; } })] });`);
    const options = { projectDir: directory, entryId: "one", args: ["nested"], actor: { userId: "alice", isSystemAdmin: false }, databaseResolver: createLocalDatabaseResolver(registry) };
    const success = await runLocalProjectWithReport(options);
    assert.equal(success.status, "success", JSON.stringify(success.result));
    if (success.result.ok) assert.equal((success.result.data as any).output.value, "alice");
    const denied = await runLocalProjectWithReport({ ...options, authorizeEntry(_entryId, _operation, actor) { assert.equal(actor.userId, "alice"); throw new Error("Caller has no operation access"); } });
    assert.equal(denied.status, "failed");
    assert.match(JSON.stringify(denied.result), /Caller has no operation access/);
    const toolDenied = await runLocalProjectWithReport({ ...options, inheritedToolPermissions: createProjectToolPermissionContext({ definitions: [{ name: "entry:two:read", enabled: false }], projectName: "Caller", runId: "one" }) });
    assert.equal(toolDenied.status, "failed");
    assert.match(JSON.stringify(toolDenied.result), /caller disabled/);
    registry.narrow(registry.authorization(approval.bindingRef!)!.grant.grantId, { ...permissions, kv: { read: all, write: { mode: "none" } } });
    const narrowed = await runLocalProjectWithReport(options);
    assert.equal(narrowed.status, "failed");
    assert.match(JSON.stringify(narrowed.result), /does not allow/);
    registry.revoke(registry.authorization(approval.bindingRef!)!.grant.grantId);
    const revoked = await runLocalProjectWithReport(options);
    assert.equal(revoked.status, "failed");
    assert.match(JSON.stringify(revoked.result), /host authorization/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
