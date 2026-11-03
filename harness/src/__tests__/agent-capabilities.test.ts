import { createTestResources } from "./entry-test-resources";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  KNOWLEDGE_CAPABILITY,
  KNOWLEDGE_MCP_TOOL_ID,
  PRESENTATION_CARD_MCP_TOOL_ID,
  STEAMHARNESS_CAPABILITIES,
  createProjectCapabilityServer,
  createProjectCapabilityTools,
  findProjectCapability,
  isProjectCapabilityAvailable,
  listProjectCapabilityToolIds,
  readHostConfigurationBridgeConfig,
  runProjectCapabilityAction,
} from "../agent/capabilities/index";
import {
} from "../index";
import type { NodeContext } from "../types/context";

const BRIDGE_URL_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_URL";
const BRIDGE_TOKEN_ENV = "STEAMHARNESS_DEVELOPER_ASSISTANT_HOST_BRIDGE_TOKEN";

type JsonPage = { paged: true; content: string; resultHash: string; nextOffset?: number; truncated: boolean };

async function collectJsonPages(call: (args: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
  let args: Record<string, unknown> = {}, content = "", pages = 0;
  do {
    const result = await call(args) as JsonPage;
    assert.equal(result.paged, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 40_000);
    assert.equal(Buffer.from(result.content).toString(), result.content);
    content += result.content; pages++;
    if (!result.truncated) { assert.equal(result.nextOffset, undefined); break; }
    assert.ok(result.nextOffset! > Number(args.resultOffset ?? 0));
    args = { resultOffset: result.nextOffset, resultHash: result.resultHash };
  } while (pages < 100);
  assert.ok(pages > 1);
  return JSON.parse(content);
}

test("document writes return bounded acknowledgements and can be fully read afterward", async () => {
  const context = createContext();
  const markdown = `START${'中文😀"\\\u0001'.repeat(8000)}END`;
  const created = await runCapability(KNOWLEDGE_MCP_TOOL_ID, context,
    { action: "create", documentId: "big-doc", title: "Big doc", markdown, includeMarkdown: true, maxMarkdownLength: 20_000 });
  assert.ok(Buffer.byteLength(JSON.stringify(created)) <= 40_000);
  for (const maxMarkdownLength of [-1, 1.5, 20_001, "100"]) {
    await assert.rejects(() => runCapability(KNOWLEDGE_MCP_TOOL_ID, context,
      { action: "edit", documentId: "big-doc", markdown: "must not write", maxMarkdownLength }), /maxMarkdownLength/);
  }
});

test("knowledge documents are managed through one tool", async () => {
  const context = createContext();

  assert.deepEqual(await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, { action: "list" }), {
    action: "list",
    count: 0,
    documents: [],
    hasMore: false,
    nextCursor: undefined,
  });

  const created = await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
    action: "create",
    documentId: "guide",
    title: "Guide",
    markdown: "# Guide\n\nFirst line.\nSecond line.",
  }) as { action: string; document: { id: string; title: string; lineCount: number } };
  assert.equal(created.action, "create");
  assert.equal(created.document.id, "guide");
  assert.equal(created.document.lineCount, 4);

  // `get` includes the body by default and `create` does not: reading is the
  // common case, and an echoed create would double the token cost of a write.
  const got = await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
    action: "get",
    documentId: "guide",
  }) as { document: { markdown?: string } };
  assert.equal(got.document.markdown, "# Guide\n\nFirst line.\nSecond line.");

  const searched = await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
    action: "search",
    query: "First",
  }) as { matches: unknown[] };
  assert.equal(searched.matches.length, 1);

  const lines = await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
    action: "read_lines",
    documentId: "guide",
    startLine: 3,
    endLine: 3,
  }) as { lines: { content: string }[] };
  assert.deepEqual(lines.lines.map((line) => line.content), ["First line."]);

  assert.deepEqual(await runCapability(KNOWLEDGE_MCP_TOOL_ID, context, {
    action: "delete",
    documentId: "guide",
  }), { action: "delete", id: "guide", deleted: true });
});

test("knowledge reports a missing field as a validation failure, not a crash", async () => {
  const context = createContext();

  await assert.rejects(
    () => runCapability(KNOWLEDGE_MCP_TOOL_ID, context, { action: "get" }),
    /requires documentId/u,
  );
  await assert.rejects(
    () => runCapability(KNOWLEDGE_MCP_TOOL_ID, context, { action: "frobnicate" }),
    /action is invalid/u,
  );
});

function textOf(content: unknown): string {
  const [block] = content as { type: string; text: string }[];
  return block!.text;
}

function runCapability(
  toolId: string,
  context: NodeContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  return runProjectCapabilityAction(toolId, context, { ...(toolId === KNOWLEDGE_MCP_TOOL_ID ? { knowledgeBase: "data" } : { database: "data" }), ...args });
}

function createContext(): NodeContext {
  const store = {};
  return createTestResources(store) as unknown as NodeContext;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
