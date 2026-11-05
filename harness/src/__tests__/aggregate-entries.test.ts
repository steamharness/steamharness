import { withBotRequest } from "../agent/bot-lifecycle";
import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectAggregateProjectStructure, inspectLocalProjectStructure, runLocalProjectWithReport } from "../executor/index";
import { createLocalProjectConfigurationStore } from "../configuration";
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
  const entries = ["one", "two", "chat", "board"].map((entryId) => ({ entryId, name: entryId, type: entryId === "chat" ? "bot" : entryId === "board" ? "kanban" : "workflow", root: ".", entry: `${entryId}.${entryId === "board" ? "html" : "ts"}`, databases: [], configuration: `${entryId}.json` }));
  await writeProjectFixture(path.join(directory, "package.json"), JSON.stringify({ id: projectId, name: "aggregate-test", type: "module", version: "0.1.0",  entries, defaultEntry: "one"  }));
  for (const entry of entries) {
    await writeFile(path.join(directory, entry.configuration), JSON.stringify({ version: 1, fields: [{ name: "label", label: "Label", type: "string", defaultValue: entry.entryId }] }));
    if (entry.type === "kanban") { await writeFile(path.join(directory, entry.entry), "<!doctype html><title>Board</title>"); continue; }
    if (entry.type === "bot") { await writeFile(path.join(directory, entry.entry), 'export const executor = steamharness.defineBot({});'); continue; }
    const workflow = `const flow = steamharness.defineProject({ name: "${entry.entryId}", async run(input, context) {
      if (input.nested) return context.entries.get("two").runEntrypoint("read");
      return { errCode: 0, errMessage: "", entryId: context.metadata.entryId, label: context.config.label, actor: context.actor };
    }});`;
    const executor = entry.type === "bot" ? 'projectType: "bot", workflow: flow, createInput() { return {}; }' : 'projectType: "workflow", defaultEntrypoint: "read", entrypoints: [steamharness.defineEntrypoint({ id: "read", title: "Read", workflow: flow, createInput(context) { return { nested: context.args.includes("nested") }; } })]';
    await writeFile(path.join(directory, entry.entry), `${workflow}\nexport const executor = steamharness.defineExecutor({ ${executor} });`);
  }
  return { directory, projectId };
}

test("registered modules isolate static analysis even when all entries share a code root", async () => {
  const { directory, projectId } = await fixture();
  try {
    const structures = inspectAggregateProjectStructure(directory);
    assert.equal(structures.projectId, projectId);
    assert.deepEqual(structures.entries.map((entry) => entry.projectType), ["workflow", "workflow", "bot", "kanban"]);
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

test('Conversation entry control preserves trusted provenance, permissions and cancellation', async () => {
  const manifest = { projectId:'aggregate',name:'test',defaultEntry:'chat',entries:[{entryId:'chat',type:'bot' as const,name:'chat',root:'.',entry:'chat.ts',databases:[]}] };
  const abort = new AbortController(), calls: unknown[]=[];
  const identity={actor:{userId:'alice',isSystemAdmin:false},projectId:'aggregate',sourceEntryId:'api',sourceConversationId:'caller',sourceRunId:'turn',abortSignal:abort.signal};
  const entries=createEntriesContext(manifest,identity,{list:async()=>[],run:async()=>{}},{invoke:async(entry,action,input,actor)=>{calls.push({entry,action,input,actor});return {conversationId:'target',requestId:'r',messageId:'r',status:'accepted'};}},{entryId:'board'});
  assert.equal(entries.caller?.entryId,'board');assert.ok(Object.isFrozen(entries.caller));
  await entries.conversations.get('chat').submit({conversationId:'target',requestId:'r',text:'hello'});
  assert.deepEqual((calls[0] as any).actor,identity);
  assert.throws(()=>entries.get('chat'),/Workflow/);
  abort.abort(new Error('caller stopped'));
  await assert.rejects(entries.conversations.get('chat').snapshot('target'),/caller stopped/);
  assert.equal(calls.length,1);
  const unavailable=createEntriesContext(manifest,{...identity,abortSignal:undefined},{list:async()=>[],run:async()=>{}});
  await assert.rejects(unavailable.conversations.get('chat').list(),{code:'ENTRY_RUNTIME_UNAVAILABLE'});
  const disabled=createEntriesContext(manifest,{...identity,abortSignal:undefined,toolPermissions:{getTool:()=>({enabled:false})} as any},{list:async()=>[],run:async()=>{}},{invoke:async()=>{throw new Error('must not execute');}});
  await assert.rejects(disabled.conversations.get('chat').list(),/disabled/);
});

test("Bot message provenance does not replace a nested Workflow run identity", async () => {
  const manifest = { projectId: "project", name: "Scopes", defaultEntry: "api", entries: [{ entryId: "api", type: "workflow" as const, name: "API", root: ".", entry: "index.ts", databases: [] }] };
  for (const sourceEntryId of ["bot", "api"]) {
    let caller: string | undefined;
    const entries = createEntriesContext(manifest, { actor: { userId: "alice", isSystemAdmin: false }, projectId: "project", sourceEntryId, sourceRunId: "workflow-run" },
      { async list() { return []; }, async run(_entry, _operation, _args, identity) { caller = identity.sourceRunId; return {}; } });
    await withBotRequest("bot-message", () => entries.get("api").runEntrypoint("main"), { projectId: "project", entryId: "bot" });
    assert.equal(caller, sourceEntryId === "bot" ? "bot-message" : "workflow-run");
  }
});
