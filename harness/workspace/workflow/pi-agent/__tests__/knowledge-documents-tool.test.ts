import { beforeAll, describe, expect, it } from "vitest";
import {
  createDisabledWorkflowConversationContext,
  createDisabledWorkflowTokenUsageContext,
  createWorkflowKVContext,
  createWorkflowPersistentValueContext,
  createWorkflowRelatedProjectsContext,
  createWorkflowToolPermissionContext,
  type KVStore,
} from "steamharness";
import { installWorkflowRuntimeGlobal } from "steamharness/runtime-api";
import type { RunContext } from "steamharness/types/context";
import {
  KNOWLEDGE_DOCUMENTS_TOOL_NAME,
  createKnowledgeDocumentsTool,
} from "../knowledge-documents-tool";

installWorkflowRuntimeGlobal();

let context: RunContext;

beforeAll(() => {
  context = createToolContext();
});

describe("pi-agent knowledge_documents tool", () => {
  it("registers the Pi SDK custom tool shape", () => {
    const tool = createKnowledgeDocumentsTool({ context });

    expect(tool.name).toBe(KNOWLEDGE_DOCUMENTS_TOOL_NAME);
    expect(tool.label).toBe("Knowledge Documents");
    expect(tool.parameters).toMatchObject({
      type: "object",
      required: ["action"],
    });
  });

  it("creates, gets, searches, reads lines, and deletes a knowledge document", async () => {
    const tool = createKnowledgeDocumentsTool({ context });

    const createResult = parseToolResult<{
      action: "create";
      document: { id: string; title: string; lineCount: number };
    }>(await tool.execute("call-create", {
      action: "create",
      documentId: "agent-runbook",
      title: "Agent Runbook",
      markdown: "# Agent Runbook\n\nUse PersistentValue for knowledge documents.\n\nSearchable line.",
    }, undefined, undefined, {} as never));
    expect(createResult.action).toBe("create");
    expect(createResult.document.id).toBe("agent-runbook");
    expect(createResult.document.title).toBe("Agent Runbook");
    expect(createResult.document.lineCount).toBe(5);

    const listResult = parseToolResult<{
      action: "list";
      count: number;
      documents: Array<{ id: string }>;
    }>(await tool.execute("call-list", { action: "list" }, undefined, undefined, {} as never));
    expect(listResult.count).toBe(1);
    expect(listResult.documents[0]?.id).toBe("agent-runbook");

    const getResult = parseToolResult<{
      action: "get";
      found: boolean;
      document: { markdown: string };
    }>(await tool.execute("call-get", {
      action: "get",
      documentId: "agent-runbook",
      includeMarkdown: true,
    }, undefined, undefined, {} as never));
    expect(getResult.found).toBe(true);
    expect(getResult.document.markdown).toContain("Searchable line.");

    const searchResult = parseToolResult<{
      action: "search";
      totalMatches: number;
      matches: Array<{ line: string }>;
    }>(await tool.execute("call-search", {
      action: "search",
      query: "PersistentValue",
      documentId: "agent-runbook",
      beforeLines: 1,
      afterLines: 1,
      pageSize: 5,
    }, undefined, undefined, {} as never));
    expect(searchResult.totalMatches).toBe(1);
    expect(searchResult.matches[0]?.line).toContain("PersistentValue");

    const linesResult = parseToolResult<{
      action: "read_lines";
      lines: Array<{ lineNumber: number; content: string }>;
    }>(await tool.execute("call-lines", {
      action: "read_lines",
      documentId: "agent-runbook",
      startLine: 1,
      endLine: 2,
    }, undefined, undefined, {} as never));
    expect(linesResult.lines).toEqual([
      { lineNumber: 1, content: "# Agent Runbook" },
      { lineNumber: 2, content: "" },
    ]);

    const deleteResult = parseToolResult<{
      action: "delete";
      id: string;
      deleted: boolean;
    }>(await tool.execute("call-delete", {
      action: "delete",
      documentId: "agent-runbook",
    }, undefined, undefined, {} as never));
    expect(deleteResult.deleted).toBe(true);

    const afterList = parseToolResult<{ count: number }>(
      await tool.execute("call-after-list", { action: "list" }, undefined, undefined, {} as never),
    );
    expect(afterList.count).toBe(0);
  });

  it("returns an error payload for unknown actions", async () => {
    const tool = createKnowledgeDocumentsTool({ context });
    const result = parseToolResult<{ errCode: number; errMessage: string }>(
      await tool.execute("call-error", { action: "explode" }, undefined, undefined, {} as never),
    );

    expect(result.errCode).toBe(1);
    expect(result.errMessage).toContain("explode");
  });

  it("propagates tool approval waits and denials", async () => {
    let pendingApprovalError: workflow.HarnessError | undefined;
    const waitingContext = createToolContext({ autoApprove: false });
    const waitingTool = createKnowledgeDocumentsTool({
      context: waitingContext,
      onPendingApproval(error) {
        pendingApprovalError = error;
      },
    });
    await expect(waitingTool.execute(
      "call-waiting",
      { action: "list" },
      undefined,
      undefined,
      {} as never,
    )).rejects.toMatchObject({
      name: "HarnessError",
      type: "user_input_required",
    });
    expect(pendingApprovalError).toMatchObject({
      name: "HarnessError",
      type: "user_input_required",
    });

    const deniedContext = createToolContext({ enabled: false });
    const deniedTool = createKnowledgeDocumentsTool({ context: deniedContext });
    await expect(deniedTool.execute(
      "call-denied",
      { action: "list" },
      undefined,
      undefined,
      {} as never,
    )).rejects.toMatchObject({
      name: "HarnessError",
      type: "tool_permission_denied",
    });
  });

  it("emits an approval decision item before executing after resume", async () => {
    const emitted: unknown[] = [];
    const approvedContext = createToolContext(
      { autoApprove: false },
      {
        getResolvedInput(requestId, request) {
          return {
            requestId,
            nodeName: request?.nodeName ?? "tool-approval",
            values: { approved: true },
            submittedAt: new Date("2026-06-16T00:00:00.000Z"),
            request,
          };
        },
        requestInput() {
          throw new Error("requestInput should not run for approved resumes.");
        },
      },
    );
    const tool = createKnowledgeDocumentsTool({
      context: approvedContext,
      emit(event) {
        emitted.push(event);
      },
    });

    const result = parseToolResult<{ action: "list"; count: number }>(
      await tool.execute("call-approved", { action: "list" }, undefined, undefined, {} as never),
    );

    expect(result).toMatchObject({ action: "list", count: 0 });
    expect(emitted).toContainEqual({
      type: "output_chunk",
      chunk: expect.objectContaining({
        type: "output_item_start",
        item: expect.objectContaining({
          title: "工具权限审批 · Knowledge Documents · 已批准",
          metadata: expect.objectContaining({
            kind: "pi-agent-tool-approval",
            status: "approved",
            toolName: KNOWLEDGE_DOCUMENTS_TOOL_NAME,
            requestId: expect.stringMatching(/^pi-agent:pi-agent-test-run:tool-approval:knowledge_documents:[a-f0-9]{64}$/),
          }),
        }),
      }),
    });
  });
});

function parseToolResult<T>(result: Awaited<ReturnType<ReturnType<typeof createKnowledgeDocumentsTool>["execute"]>>): T {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first.text) as T;
}

function createToolContext(
  toolPolicy: { enabled?: boolean; autoApprove?: boolean } = {},
  userInput: RunContext["userInput"] = {
    async getResolvedInput() {
      return undefined;
    },
    async requestInput() {},
  },
): RunContext {
  const store = createMemoryKVStore();
  return {
    providers: {},
    storage: {
      local: {
        kv: createWorkflowKVContext({ store, projectId: "7afb5837-251e-4938-bae4-83f8569d9d6b" }),
        persistentValue: createWorkflowPersistentValueContext({
          store,
          projectId: "7afb5837-251e-4938-bae4-83f8569d9d6b",
        }),
        relatedProjects: createWorkflowRelatedProjectsContext(),
      },
      server: {
        kv: createWorkflowKVContext({ store, projectId: "7afb5837-251e-4938-bae4-83f8569d9d6b" }),
        persistentValue: createWorkflowPersistentValueContext({
          store,
          projectId: "7afb5837-251e-4938-bae4-83f8569d9d6b",
        }),
        relatedProjects: createWorkflowRelatedProjectsContext(),
      },
    },
    conversation: createDisabledWorkflowConversationContext(),
    tokenUsage: createDisabledWorkflowTokenUsageContext(),
    userInput,
    metadata: {
      workflow: "pi-agent",
      runId: "pi-agent-test-run",
    },
    toolPermissions: createWorkflowToolPermissionContext({
      projectName: "pi-agent",
      runId: "pi-agent-test-run",
      definitions: [
        {
          name: KNOWLEDGE_DOCUMENTS_TOOL_NAME,
          enabled: true,
          autoApprove: true,
        },
      ],
      policies: {
        [KNOWLEDGE_DOCUMENTS_TOOL_NAME]: toolPolicy,
      },
    }),
  };
}

function createMemoryKVStore(): KVStore {
  const values = new Map<string, unknown>();
  const namespaceTails = new Map<string, Promise<void>>();
  function createKey(input: {
    storageKind: string;
    scope: string;
    projectId: string;
    conversationId?: string;
    key: string;
  }): string {
    return [input.storageKind, input.scope, input.projectId, input.conversationId ?? "", input.key].join(":");
  }

  return {
    async getValue(input) {
      return values.get(createKey(input));
    },
    async setValue(input) {
      values.set(createKey(input), input.value);
    },
    async updateValue(input, updater) {
      const key = createKey(input);
      const next = updater(values.get(key));
      values.set(key, next);
      return next;
    },
    async withNamespaceLock(input, operation) {
      const namespace = [input.storageKind, input.scope, input.projectId, input.conversationId ?? ""].join(":");
      const previous = namespaceTails.get(namespace) ?? Promise.resolve();
      let release!: () => void;
      const completion = new Promise<void>((resolve) => {
        release = resolve;
      });
      namespaceTails.set(namespace, completion);
      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    },
  };
}
