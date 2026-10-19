import { describe, expect, it } from "vitest";
import {
  __test_createDelayedToolEventBuffer,
  createPiAgentSessionSnapshot,
  createPiAgentTokenUsageReport,
  createWorkflowToolPermissionExtension,
} from "../pi-sdk";
import { KNOWLEDGE_DOCUMENTS_TOOL_NAME } from "../knowledge-documents-tool";
import {
  createDisabledWorkflowConversationContext,
  createDisabledWorkflowTokenUsageContext,
  createWorkflowRelatedProjectsContext,
  createWorkflowToolPermissionContext,
  type KVContext,
} from "steamharness";
import { installWorkflowRuntimeGlobal } from "steamharness/runtime-api";
import type { RunContext } from "steamharness/types/context";

installWorkflowRuntimeGlobal();

describe("pi-agent SDK adapter", () => {
  it("reads token usage from the current Pi SDK getSessionStats method", () => {
    const snapshot = createPiAgentSessionSnapshot({
      sessionId: "session-current",
      messages: [{ role: "assistant", content: "ok" }],
      getActiveToolNames: () => ["read"],
      getSessionStats: () => ({
        tokens: {
          input: 11,
          output: 7,
          cacheRead: 3,
          cacheWrite: 2,
          total: 23,
        },
      }),
    });

    expect(snapshot).toEqual({
      sessionId: "session-current",
      messages: [{ role: "assistant", content: "ok" }],
      activeTools: ["read"],
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 23,
      },
    });
  });

  it("keeps the older getStats fallback for SDK experiments", () => {
    const snapshot = createPiAgentSessionSnapshot({
      getStats: () => ({
        tokens: {
          input: 5,
          output: 4,
        },
      }),
    });

    expect(snapshot.activeTools).toEqual([]);
    expect(snapshot.usage).toEqual({
      inputTokens: 5,
      outputTokens: 4,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      totalTokens: 9,
    });
  });

  it("maps Pi cache usage into workflow token usage detail fields", () => {
    const report = createPiAgentTokenUsageReport({
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 23,
      },
    });

    expect(report).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 23,
      cachedInputTokens: 3,
      cacheCreationTokens: 2,
      providerName: "pi",
      metadata: {
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
      },
    });
  });

  it("maps Pi built-in tool_call events through workflow tool approval", async () => {
    const approvedHandler = await createToolCallHandler(createToolContext());
    await expect(approvedHandler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "call-approved",
      input: { command: "pwd" },
    })).resolves.toBeUndefined();

    const disabledHandler = await createToolCallHandler(createToolContext({
      bash: { enabled: false },
    }));
    await expect(disabledHandler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "call-disabled",
      input: { command: "pwd" },
    })).resolves.toEqual({
      block: true,
      reason: expect.stringContaining("disabled"),
    });

    const waitingHandler = await createToolCallHandler(createToolContext({
      bash: { autoApprove: false },
    }));
    await expect(waitingHandler({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "call-waiting",
      input: { command: "pwd" },
    })).rejects.toMatchObject({
      name: "HarnessError",
      type: "user_input_required",
    });
  });

  it("lets the knowledge_documents custom tool own its approval gate", async () => {
    const handler = await createToolCallHandler(createToolContext({
      [KNOWLEDGE_DOCUMENTS_TOOL_NAME]: { autoApprove: false },
    }));

    await expect(handler({
      type: "tool_call",
      toolName: KNOWLEDGE_DOCUMENTS_TOOL_NAME,
      toolCallId: "call-knowledge",
      input: { action: "list" },
    })).resolves.toBeUndefined();
  });

  it("delays knowledge_documents tool lifecycle rows until the approval item is complete", () => {
    const buffer = __test_createDelayedToolEventBuffer(KNOWLEDGE_DOCUMENTS_TOOL_NAME, true);
    const queue: unknown[] = [];

    expect(buffer.push({
      type: "tool",
      phase: "start",
      toolCallId: "call-knowledge",
      toolName: KNOWLEDGE_DOCUMENTS_TOOL_NAME,
      args: { action: "list" },
    })).toBe(true);
    expect(queue).toEqual([]);

    queue.push({
      type: "output_chunk",
      chunk: {
        type: "output_item_start",
        item: {
          id: "pi-agent-tool-approval-request-approved",
          title: "工具权限审批 · Knowledge Documents · 已批准",
          content: {},
        },
      },
    });
    queue.push({
      type: "output_chunk",
      chunk: {
        type: "output_item_end",
        itemId: "pi-agent-tool-approval-request-approved",
      },
    });
    buffer.releaseTo(queue as never[]);

    expect(queue.map(readQueuedEventKind)).toEqual([
      "output_item_start",
      "output_item_end",
      "tool:start:knowledge_documents",
    ]);
  });
});

async function createToolCallHandler(context: RunContext) {
  const handlers: Array<(event: {
    type: "tool_call";
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  }) => Promise<{ block?: boolean; reason?: string } | undefined>> = [];
  const extension = createWorkflowToolPermissionExtension(context);
  await extension({
    on(event, handler) {
      expect(event).toBe("tool_call");
      handlers.push(handler);
    },
  });
  const handler = handlers[0];
  expect(handler).toBeDefined();
  return handler;
}

function createToolContext(
  policies: Record<string, { enabled?: boolean; autoApprove?: boolean }> = {},
): RunContext {
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
    userInput: {
      async getResolvedInput() {
        return undefined;
      },
      async requestInput() {},
    },
    toolPermissions: createWorkflowToolPermissionContext({
      projectName: "pi-agent",
      runId: "pi-agent-sdk-test-run",
      definitions: [
        { name: "bash", enabled: true, autoApprove: true },
        { name: KNOWLEDGE_DOCUMENTS_TOOL_NAME, enabled: true, autoApprove: true },
      ],
      policies,
    }),
  };
}

function createMemoryKVContext(): KVContext {
  const values = new Map<string, unknown>();
  function createNamespace(prefix: string) {
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
    };
  }
  const project = createNamespace("project");
  return {
    getValue: project.getValue,
    setValue: project.setValue,
    updateValue: project.updateValue,
    conversation: createNamespace("conversation"),
  };
}

function readQueuedEventKind(event: unknown): string {
  if (typeof event !== "object" || event === null) {
    return "unknown";
  }
  const typed = event as {
    type?: string;
    phase?: string;
    toolName?: string;
    chunk?: { type?: string };
  };
  if (typed.type === "tool") {
    return `tool:${typed.phase}:${typed.toolName}`;
  }
  if (typed.type === "output_chunk") {
    return typed.chunk?.type ?? "output_chunk";
  }
  return typed.type ?? "unknown";
}
