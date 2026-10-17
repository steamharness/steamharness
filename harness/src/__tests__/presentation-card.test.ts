import assert from "node:assert/strict";
import test from "node:test";
import { PRESENTATION_CARD_MCP_TOOL_ID, runPresentationCardAction } from "../agent/capabilities/index";
import type { NodeContext } from "../types/context";

const context = {} as NodeContext;

test("Kanban cards accept an independent named configuration target", async () => {
  const args = { action: "upsert" as const, cardId: "configuration-one", kind: "kanban" as const,
    target: { source: "current", configurationId: "configuration-one" }, preview: true };
  assert.deepEqual(await runPresentationCardAction(context, args), args);
  await assert.rejects(() => runPresentationCardAction(context, {
    ...args, kind: "kv", target: { ...args.target, scope: "project", key: "map" },
  }), /invalid field/u);
});

test("a current-host preview captures the configuration without changing the host selection", async () => {
  const urlKey = "STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL";
  const tokenKey = "STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN";
  const priorUrl = process.env[urlKey];
  const priorToken = process.env[tokenKey];
  const priorFetch = globalThis.fetch;
  const requests: unknown[] = [];
  try {
    process.env[urlKey] = "http://127.0.0.1:4321/bridge";
    process.env[tokenKey] = "test-token";
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, value: { activeConfigurationId: "configuration-one" } }));
    }) as typeof fetch;
    const output = await runPresentationCardAction(context, {
      action: "upsert", cardId: "map", kind: "kanban", target: { source: "current" }, preview: true,
    });
    assert.deepEqual((output as { target: unknown }).target, { source: "current", configurationId: "configuration-one" });
    assert.deepEqual(requests, [{ operation: "kanban.configuration.get", input: {} }]);
    await runPresentationCardAction(context, {
      action: "upsert", cardId: "default", kind: "kanban", target: { source: "current", configurationId: "default" }, preview: true,
    });
    assert.equal(requests.length, 1);
    await runPresentationCardAction(context, {
      action: "upsert", cardId: "saved", kind: "kanban", target: { source: "current", configurationId: "default" },
      kanban: { mode: "save", values: { title: "Saved" } },
    });
    assert.deepEqual(requests[1], { operation: "kanban.configuration.update", input: { configurationId: "default", values: { title: "Saved" } } });
  } finally {
    globalThis.fetch = priorFetch;
    if (priorUrl === undefined) delete process.env[urlKey]; else process.env[urlKey] = priorUrl;
    if (priorToken === undefined) delete process.env[tokenKey]; else process.env[tokenKey] = priorToken;
  }
});

test("presentation card upserts and removes by stable card id", async () => {
  assert.equal(PRESENTATION_CARD_MCP_TOOL_ID, "workflow-ui_present_card");
  assert.deepEqual(await runPresentationCardAction(context, {
    action: "upsert",
    cardId: "board:active",
    kind: "kanban",
    target: { source: "current" },
    pinned: true,
    preview: true,
    kanban: { mode: "preview", values: { title: "Roadmap", columns: 3 } },
  }), {
    action: "upsert",
    cardId: "board:active",
    kind: "kanban",
    target: { source: "current" },
    pinned: true,
    preview: true,
    kanban: { mode: "preview", values: { title: "Roadmap", columns: 3 } },
  });
  assert.deepEqual(await runPresentationCardAction(context, {
    action: "remove",
    cardId: "board:active",
  }), { action: "remove", cardId: "board:active" });
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "remove", cardId: "board:active", pinned: true,
  }), /only its card id/u);
});

test("presentation card rejects unsafe targets and malformed preview parameters", async () => {
  assert.deepEqual(await runPresentationCardAction(context, {
    action: "upsert", cardId: "browser", kind: "browser", target: { url: "https://example.com" }, preview: false,
  }), {
    action: "upsert", cardId: "browser", kind: "browser", target: { url: "https://example.com/" }, preview: false,
  });
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "file", target: { source: "current", filePath: "src/index.ts" }, preview: true,
  }), /preview requires/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "file", target: { source: "current", filePath: "src/index.ts" }, preview: false,
  }), /preview requires/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "project", target: { source: "current" }, preview: "true" as unknown as boolean,
  }), /preview must be a boolean/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "browser", target: { url: "javascript:alert(1)" },
  }), /HTTP\(S\)/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "file", target: { source: "local", projectId: "p", filePath: "../secret" },
  }), /workspace-relative/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "file", target: { source: "local", projectId: "p", filePath: "C:\\secret" },
  }), /workspace-relative/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "x", kind: "kanban", target: { source: "current" },
    kanban: { mode: "preview", values: { nested: { secret: true } } },
  }), /parameter is invalid/u);
  await assert.rejects(() => runPresentationCardAction(context, {
    action: "upsert", cardId: "bad id", kind: "project", target: { source: "current" },
  }), /Card id/u);
});

test("Kanban save mode uses the host named-configuration update", async () => {
  const urlKey = "STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL";
  const tokenKey = "STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN";
  const priorUrl = process.env[urlKey];
  const priorToken = process.env[tokenKey];
  const priorFetch = globalThis.fetch;
  let body: unknown;
  try {
    process.env[urlKey] = "http://127.0.0.1:4321/bridge";
    process.env[tokenKey] = "test-token";
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ ok: true, value: { id: "saved" } }), { status: 200 });
    }) as typeof fetch;
    await runPresentationCardAction(context, {
      action: "upsert", cardId: "board", kind: "kanban", target: { source: "current" },
      kanban: { mode: "save", values: { title: "Saved" } },
    });
    assert.deepEqual(body, {
      operation: "kanban.configuration.update",
      input: { values: { title: "Saved" } },
    });
  } finally {
    globalThis.fetch = priorFetch;
    if (priorUrl === undefined) delete process.env[urlKey]; else process.env[urlKey] = priorUrl;
    if (priorToken === undefined) delete process.env[tokenKey]; else process.env[tokenKey] = priorToken;
  }
});
