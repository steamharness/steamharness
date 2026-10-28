import { createApprovedTestContext } from "../../../test-databases";
import { describe, expect, it, vi } from "vitest";
import {
  __test_createDelayedToolEventBuffer,
  createPiAgentSessionSnapshot,
  createPiAgentTokenUsageReport,
  createProjectToolPermissionExtension,
  configurePiProjectAuthentication,
  createPiAgentSessionFactory,
} from "../pi-sdk";
import { KNOWLEDGE_DOCUMENTS_TOOL_NAME } from "../knowledge-documents-tool";
import {
  createDisabledProjectConversationContext,
  createDisabledProjectTokenUsageContext,
  createProjectToolPermissionContext,
  type KVContext,
} from "steamharness";
import { installProjectRuntimeGlobal } from "steamharness/runtime-api";
import type { RunContext } from "steamharness/types/context";

installProjectRuntimeGlobal();

describe("pi-agent SDK adapter", () => {
  it("captures configuration credentials and blocks the SDK's process environment fallback", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "environment-key");
    try {
      let key: string | undefined = "project-key";
      const auth = configurePiProjectAuthentication({
        setRuntimeApiKey() {},
        async getApiKey(_provider: string) {return process.env.ANTHROPIC_API_KEY;},
        hasAuth(_provider: string) {return true;},
      }, {getConfig: name => name === "ANTHROPIC_API_KEY" ? key : undefined});
      key = "changed";
      expect(await auth.getApiKey("anthropic")).toBe("project-key");
      expect(await auth.getApiKey("google")).toBeUndefined();
      expect(auth.hasAuth("google")).toBe(false);
      key = undefined;
      const empty = configurePiProjectAuthentication(auth, {getConfig: () => undefined});
      expect(await empty.getApiKey("anthropic")).toBeUndefined();
      expect(empty.hasAuth("anthropic")).toBe(false);
      await expect(createPiAgentSessionFactory({getConfig:()=>undefined})({prompt:"test",workdir:process.cwd(),provider:"anthropic",tools:[],explicitTools:true,knowledgeTools:false,dryRun:false})).rejects.toMatchObject({type:"input_validation"});
    } finally {vi.unstubAllEnvs();}
  });
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
  const extension = createProjectToolPermissionExtension(context);
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
    ...createApprovedTestContext(),
    conversation: createDisabledProjectConversationContext(),
    tokenUsage: createDisabledProjectTokenUsageContext(),
    userInput: {
      async getResolvedInput() {
        return undefined;
      },
      async requestInput() {},
    },
    toolPermissions: createProjectToolPermissionContext({
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
