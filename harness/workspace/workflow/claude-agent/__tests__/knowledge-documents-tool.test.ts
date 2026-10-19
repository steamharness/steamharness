import { beforeAll, describe, expect, it } from "vitest";
import { installWorkflowRuntimeGlobal } from "steamharness/runtime-api";
import {
  createDisabledWorkflowConversationContext,
  createDisabledWorkflowTokenUsageContext,
  createWorkflowRelatedProjectsContext,
  type KVContext,
} from "steamharness";
import type { RunContext } from "steamharness/types/context";
import {
  KNOWLEDGE_DOCUMENTS_MCP_SERVER_NAME,
  KNOWLEDGE_DOCUMENTS_TOOL_NAME,
  createKnowledgeDocumentsMcpServer,
  createKnowledgeDocumentsTools,
} from "../knowledge-documents-tool";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

installWorkflowRuntimeGlobal();

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }>;

function unwrapHandler(tool: SdkMcpToolDefinition): ToolHandler {
  // The SDK wraps the raw handler in its tool factory; for tests we reach in
  // and call the function directly with the parsed args object.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tool.handler as unknown as ToolHandler;
}

function parseToolResult<T>(result: Awaited<ReturnType<ToolHandler>>): T {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first.text) as T;
}

let context: RunContext;

beforeAll(() => {
  context = createToolContext();
});

describe("claude-agent knowledge_documents tool", () => {
  it("registers the SDK MCP server with the expected name and tool", () => {
    const server = createKnowledgeDocumentsMcpServer({ context });
    expect(server.name).toBe(KNOWLEDGE_DOCUMENTS_MCP_SERVER_NAME);
    const tools = createKnowledgeDocumentsTools({ context });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(KNOWLEDGE_DOCUMENTS_TOOL_NAME);
  });

  it("creates, gets, searches, reads lines, and deletes a knowledge document", async () => {
    const tools = createKnowledgeDocumentsTools({ context });
    const handler = unwrapHandler(tools[0]);

    const createResult = parseToolResult<{
      action: "create";
      document: { id: string; title: string; lineCount: number };
    }>(await handler({
      action: "create",
      documentId: "agent-runbook",
      title: "Agent Runbook",
      markdown: "# Agent Runbook\n\nUse PersistentValue for knowledge documents.\n\nSearchable line.",
    }));
    expect(createResult.action).toBe("create");
    expect(createResult.document.id).toBe("agent-runbook");
    expect(createResult.document.title).toBe("Agent Runbook");
    expect(createResult.document.lineCount).toBe(5);

    const listResult = parseToolResult<{
      action: "list";
      count: number;
      documents: Array<{ id: string }>;
    }>(await handler({ action: "list" }));
    expect(listResult.count).toBe(1);
    expect(listResult.documents[0]?.id).toBe("agent-runbook");

    const getResult = parseToolResult<{
      action: "get";
      found: boolean;
      document: { markdown: string };
    }>(await handler({ action: "get", documentId: "agent-runbook", includeMarkdown: true }));
    expect(getResult.found).toBe(true);
    expect(getResult.document.markdown).toContain("Searchable line.");

    const searchResult = parseToolResult<{
      action: "search";
      totalMatches: number;
      matches: Array<{ line: string }>;
    }>(await handler({
      action: "search",
      query: "PersistentValue",
      documentId: "agent-runbook",
      beforeLines: 1,
      afterLines: 1,
      pageSize: 5,
    }));
    expect(searchResult.totalMatches).toBe(1);
    expect(searchResult.matches[0]?.line).toContain("PersistentValue");

    const linesResult = parseToolResult<{
      action: "read_lines";
      lines: Array<{ lineNumber: number; content: string }>;
    }>(await handler({
      action: "read_lines",
      documentId: "agent-runbook",
      startLine: 1,
      endLine: 2,
    }));
    expect(linesResult.lines).toEqual([
      { lineNumber: 1, content: "# Agent Runbook" },
      { lineNumber: 2, content: "" },
    ]);

    const deleteResult = parseToolResult<{
      action: "delete";
      id: string;
      deleted: boolean;
    }>(await handler({ action: "delete", documentId: "agent-runbook" }));
    expect(deleteResult.deleted).toBe(true);

    const afterList = parseToolResult<{ count: number }>(await handler({ action: "list" }));
    expect(afterList.count).toBe(0);
  });

  it("returns an error result for unknown actions", async () => {
    const tools = createKnowledgeDocumentsTools({ context });
    const handler = unwrapHandler(tools[0]);
    const result = await handler({ action: "explode" });
    expect(result.isError).toBe(true);
    const first = result.content[0];
    expect(first?.type).toBe("text");
    const parsed = JSON.parse(first.text);
    expect(parsed.errCode).toBe(1);
    expect(parsed.errMessage).toContain("explode");
  });

  it("requires the right fields per action", async () => {
    const tools = createKnowledgeDocumentsTools({ context });
    const handler = unwrapHandler(tools[0]);
    const result = await handler({ action: "create" });
    expect(result.isError).toBe(true);
    const first = result.content[0];
    const parsed = JSON.parse(first?.text ?? "{}");
    expect(parsed.errMessage).toContain("title");
  });
});

function createToolContext(): RunContext {
  return {
    providers: {},
    storage: {
      local: {
        kv: createMemoryKVContext(),
        persistentValue: createMemoryKVContext(),
        relatedProjects: createWorkflowRelatedProjectsContext(),
      },
      server: {
        kv: createMemoryKVContext(),
        persistentValue: createMemoryKVContext(),
        relatedProjects: createWorkflowRelatedProjectsContext(),
      },
    },
    conversation: createDisabledWorkflowConversationContext(),
    tokenUsage: createDisabledWorkflowTokenUsageContext(),
  };
}

function createMemoryKVContext(): KVContext {
  const values = new Map<string, unknown>();

  function createNamespace(prefix: string) {
    let pending = Promise.resolve();
    return {
      async getValue(key: string) {
        return values.get(`${prefix}:${key}`);
      },
      async setValue(key: string, value: unknown) {
        values.set(`${prefix}:${key}`, value);
      },
      async updateValue(key: string, updater: (current: unknown | undefined) => unknown) {
        const next = updater(values.get(`${prefix}:${key}`));
        values.set(`${prefix}:${key}`, next);
        return next;
      },
      async withLock<T>(operation: () => Promise<T> | T): Promise<T> {
        const previous = pending;
        let release!: () => void;
        pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          return await operation();
        } finally {
          release();
        }
      },
    };
  }

  const project = createNamespace("project");

  return {
    getValue: project.getValue,
    setValue: project.setValue,
    updateValue: project.updateValue,
    withLock: project.withLock,
    conversation: createNamespace("conversation"),
  };
}
