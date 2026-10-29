import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { estimateAgentTokens } from "../agent/compaction";
import { AGENT_MEMORY_CONFIGURATION_KEY, createLocalProjectConfigurationStore, withProjectConfiguration } from "../configuration";
import { getLocalProjectMemoryCapabilities } from "../executor/index";
import {
  createAgentMemoryTool,
  recallAgentMemory,
  submitAgentMemoryTurn,
  flushAgentMemoryOutbox,
  withAgentMemory,
  getAgentMemoryBinding,
  resolveAgentMemoryBinding,
  createServerAgentMemoryProvider,
  type AgentMemoryProvider,
} from "../agent/memory";
const item = {
  id: "a",
  scope: "global",
  content: "中文偏好",
  origin: "manual" as const,
  version: 1,
  updatedAt: "2026-01-01",
  sources: [],
};
function provider(
  overrides: Partial<AgentMemoryProvider> = {},
): AgentMemoryProvider {
  return {
    capabilities: async () => ({
      connected: true,
      enabled: true,
      status: "ready",
      automatic: true,
      readOnly: false,
      scopes: ["global"],
    }),
    recall: async () => [item],
    submitTurn: async () => ({}),
    list: async () => ({ items: [item] }),
    get: async () => item,
    remember: async () => item,
    update: async () => item,
    forget: async () => ({}),
    ...overrides,
  };
}
test("memory bindings are async-context scoped and can be explicitly disabled", async () => {
  await Promise.all([
    withAgentMemory({ provider: provider() }, async () => {
      await Promise.resolve();
      assert.ok(getAgentMemoryBinding());
    }),
    withAgentMemory(false, async () => {
      await Promise.resolve();
      assert.equal(getAgentMemoryBinding(), false);
    }),
  ]);
  assert.equal(getAgentMemoryBinding(), undefined);
});
test("entry capabilities follow the selected Core Agent binding without executing tools or tasks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "memory-entry-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    const entries = ["inherited", "enabled", "disabled", "wrapped", "plain"];
    await writeFile(path.join(root, "steamharness.json"), JSON.stringify({
      id: randomUUID(), name: "Memory entry capabilities", version: "1.0.0", defaultEntry: "inherited",
      entries: entries.map(entryId => ({ entryId, root: entryId })),
    }));
    for (const entryId of entries) {
      await mkdir(path.join(root, entryId));
      await writeFile(path.join(root, entryId, "steamharness.json"), JSON.stringify({
        name: entryId, type: "conversation", entry: "index.ts", databases: [],
      }));
      const isPlain = entryId === "plain";
      const wrapped = entryId === "wrapped";
      await writeFile(path.join(root, entryId, "index.ts"), `
        const agent = steamharness.createAgentConversationProject({
          ${entryId === "disabled" ? "memory: false," : entryId === "enabled" || wrapped ? "memory: true," : ""}
          createTools() { throw new Error('Inspection must not invoke tool factories'); }
        });
        const wrapper = steamharness.defineProject({ name: 'wrapper', async run() { throw new Error('Inspection must not run tasks'); } });
        export const executor = steamharness.defineExecutor({ projectType: 'conversation',
          workflow: ${isPlain || wrapped ? "wrapper" : "agent"}, ${wrapped ? "coreAgent: agent," : ""}
          createInput() { return {}; }
        });
      `);
    }
    let queries = 0;
    const p = provider({ capabilities: async () => {
      queries++;
      return { connected: true, enabled: true, status: "ready", automatic: true, readOnly: false, scopes: ["global"] };
    } });
    const capabilities = async (entryId?: string) => {
      const store = await createLocalProjectConfigurationStore(root, { entryId, rootDir: path.join(root, "profiles") });
      return withProjectConfiguration(await store.snapshot({required:false}), () => getLocalProjectMemoryCapabilities({projectDir:root,entryId}));
    };
    await withAgentMemory({ provider: p }, async () => {
      for (const entryId of ["inherited", "disabled", "plain"])
        assert.equal((await capabilities(entryId)).connected, false);
      assert.equal(queries, 0, "disabled and non-Agent entries never contact the host provider");
      for (const entryId of ["enabled", "wrapped"])
        assert.equal((await capabilities(entryId)).enabled, true);
      assert.equal(queries, 2);
      const snapshot = (enabled: boolean) => ({id:"test",name:"Test",revision:1,values:{[AGENT_MEMORY_CONFIGURATION_KEY]:enabled}});
      await withProjectConfiguration(snapshot(false), async () => {
        assert.equal((await getLocalProjectMemoryCapabilities({projectDir:root,entryId:"enabled"})).enabled,false);
      });
      assert.equal(queries,2,"project opt-out does not contact the host");
      await withProjectConfiguration(snapshot(true), async () => {
        assert.equal((await getLocalProjectMemoryCapabilities({projectDir:root,entryId:"inherited"})).enabled,true);
        assert.equal((await getLocalProjectMemoryCapabilities({projectDir:root,entryId:"disabled"})).enabled,false);
      });
      assert.equal(queries,3);
    });
    assert.equal((await capabilities()).enabled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("project opt-in never creates a provider and explicit runtime opt-out wins", async () => {
  const binding = {provider:provider()};
  const snapshot = (value: unknown) => ({id:"test",name:"Test",revision:1,values:{[AGENT_MEMORY_CONFIGURATION_KEY]:value as boolean}});
  await withAgentMemory(binding, async () => {
    assert.equal(resolveAgentMemoryBinding(),false);
    assert.equal(resolveAgentMemoryBinding(true),binding);
    assert.equal(resolveAgentMemoryBinding(binding),binding);
    for(const value of [false,"true",1]) withProjectConfiguration(snapshot(value),()=>{
      assert.equal(resolveAgentMemoryBinding(true),false);
      assert.equal(resolveAgentMemoryBinding(binding),false);
    });
    withProjectConfiguration(snapshot(true),()=>{
      assert.equal(resolveAgentMemoryBinding(),binding);
      assert.equal(resolveAgentMemoryBinding(false),false);
    });
  });
  assert.equal(resolveAgentMemoryBinding(true),false);
  assert.equal(withProjectConfiguration(snapshot(true),()=>resolveAgentMemoryBinding()),false);
});
test("recall budgets CJK content and replaces empty/deleted records each run", async () => {
  let removed = false;
  const p = provider({
    recall: async () =>
      removed
        ? []
        : Array.from({ length: 10 }, (_, i) => ({
            ...item,
            id: String(i),
            content: "中".repeat(400),
          })),
  });
  const text = await recallAgentMemory({ provider: p }, "偏好");
  assert.ok(text.includes("Current user instructions take precedence"));
  assert.ok(text.length < 2300);
  assert.ok(estimateAgentTokens(text) <= 2000, "the budget includes the reference heading");
  removed = true;
  assert.equal(await recallAgentMemory({ provider: p }, "偏好"), "");
});
test("read-only tools reject mutations and preserve stable call IDs on writes", async () => {
  const Type = { Unsafe: (s: unknown) => s } as any;
  let operationId = "";
  const p = provider({
    remember: async (input) => {
      operationId = input.operationId;
      return item;
    },
  });
  const read = createAgentMemoryTool(Type, { provider: p }, true);
  await assert.rejects(
    read.execute("call-id", { action: "remember", content: "x" } as never),
    /read-only/,
  );
  const write = createAgentMemoryTool(Type, { provider: p }, false);
  await write.execute("stable", {
    action: "remember",
    scope: "global",
    content: "x",
  } as never);
  assert.match(operationId, /^tool:[a-f0-9]{64}$/);
  await assert.rejects(
    write.execute("x", { action: "remember", scope: "project:other" } as never),
    /scope/,
  );
});
test("memory failures and throwing diagnostic handlers never fail a normal turn", async () => {
  const binding = {
    provider: provider({
      recall: async () => { throw new Error("offline"); },
      submitTurn: async () => { throw new Error("offline"); },
    }),
    onError: () => { throw new Error("diagnostic failure"); },
  };
  assert.equal(await recallAgentMemory(binding, "hello"), "");
  await assert.doesNotReject(submitAgentMemoryTurn(binding, { turnId: "t", messages: [] }));
});
test("a pending turn survives failure and can be retried from a fresh provider without storing credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "memory-outbox-"));
  try {
    const turn = {
      turnId: "turn-1",
      messages: [
        {
          id: "user-1",
          role: "user" as const,
          content: "Only visible user text",
          timestamp: 1,
        },
        {
          id: "answer-1",
          role: "assistant" as const,
          content: "Only final answer",
          timestamp: 2,
        },
      ],
    };
    await submitAgentMemoryTurn(
      {
        provider: provider({
          submitTurn: async () => {
            throw new Error("offline");
          },
        }),
        outboxDirectory: dir,
      },
      turn,
    );
    assert.equal((await readdir(dir)).length, 1);
    let submitted: unknown;
    await flushAgentMemoryOutbox({
      provider: provider({
        submitTurn: async (value) => {
          submitted = value;
          return {};
        },
      }),
      outboxDirectory: dir,
    });
    assert.deepEqual(submitted, turn);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("HTTP provider sends a scoped grant and maps current scope without exposing account identities", async () => {
  const calls: { url: string; body: any; authorization: string | null }[] = [];
  const p = createServerAgentMemoryProvider({
    serverUrl: "https://memory.test",
    getGrant: async () => ({
      token: "short-scope-grant",
      scope: "project:allowed",
    }),
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return new Response(JSON.stringify({ errCode: 0, data: item }));
    },
  });
  await p.remember({ scope: "current", content: "x", operationId: "stable" });
  assert.equal(calls[0].body.scope, "project:allowed");
  assert.equal(calls[0].authorization, "Bearer short-scope-grant");
  assert.equal("userId" in calls[0].body, false);
});
test("host-bound native memory works without an executor declaration and honors explicit denial", async () => {
  const { createNodeAgentHost } = await import("../agent/node");
  const context = { toolPermissions: { getTool: () => undefined } } as any;
  const host = createNodeAgentHost(context, "test", {
    prompt: "go",
    errCode: 0,
    errMessage: "",
  });
  await withAgentMemory({ provider: provider() }, () =>
    host.approveToolCall!({
      callId: "c",
      toolName: "memory",
      arguments: { action: "list" },
    }),
  );
  const disabled = createNodeAgentHost(
    {
      toolPermissions: {
        getTool: () => ({ name: "memory", enabled: false, autoApprove: true }),
      },
    } as any,
    "test",
    { prompt: "go", errCode: 0, errMessage: "" },
  );
  await assert.rejects(
    withAgentMemory({ provider: provider() }, () =>
      disabled.approveToolCall!({
        callId: "c",
        toolName: "memory",
        arguments: { action: "list" },
      }),
    ),
    /disabled/,
  );
});
