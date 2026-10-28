import { createApprovedTestContext } from "../../../test-databases";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { installProjectRuntimeGlobal } from "steamharness/runtime-api";
import {
  createDisabledProjectConversationContext,
  createDisabledProjectTokenUsageContext,
  createProjectToolPermissionContext,
  type KVContext,
  type UserInputResolved,
  type UserInputRequest,
} from "steamharness";
import type { NodeContext } from "steamharness/types/context";
import type { ClaudeAgentSessionInput } from "../interface";

installProjectRuntimeGlobal();

const KNOWLEDGE_TOOL = "mcp__steamharness-knowledge-documents__knowledge_documents";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((server) => server),
  tool: vi.fn((name, description, schema, handler) => ({ name, description, schema, handler })),
  query: vi.fn(async function* (input: {
    options: {
      canUseTool?: (
        toolName: string,
        input: Record<string, unknown>,
        options: { toolUseID: string; signal: AbortSignal; displayName?: string },
      ) => Promise<unknown>;
    };
  }) {
    yield {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          name: KNOWLEDGE_TOOL,
          input: { action: "list" },
        },
      },
    };

    try {
      await input.options.canUseTool?.(
        KNOWLEDGE_TOOL,
        { action: "list" },
        {
          toolUseID: "toolu-list",
          signal: new AbortController().signal,
          displayName: "Knowledge Documents",
        },
      );
    } catch {
      // The Claude SDK surfaces a model-visible denial instead of stopping
      // iteration;  requires the workflow wrapper to pause anyway.
    }

    yield {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: {
          type: "tool_result",
          content: JSON.stringify({ action: "list", count: 0, documents: [] }),
        },
      },
    };
    yield {
      type: "stream_event",
      event: {
        type: "content_block_stop",
      },
    };

    yield {
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "text" },
      },
    };
    yield {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "This text must not be consumed while approval is pending.",
        },
      },
    };
  }),
}));

type OutputNodeLike = {
  stream(input: ClaudeAgentSessionInput, context: NodeContext): AsyncGenerator<unknown>;
};

let outputNode: OutputNodeLike;

beforeAll(async () => {
  const module = await import("../index");
  outputNode = (module as unknown as { __test_outputNode: OutputNodeLike }).__test_outputNode;
});

describe("claude-agent tool approval stream", () => {
  it("requires a project key even when the parent process has Claude credentials", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "environment-key");
    try {
      const {query} = await import("@anthropic-ai/claude-agent-sdk");
      const calls = vi.mocked(query).mock.calls.length;
      const context = createNodeContext([]); context.config = {};
      await expect(outputNode.stream(createSessionInput(), context).next()).rejects.toMatchObject({type:"input_validation"});
      expect(vi.mocked(query).mock.calls).toHaveLength(calls);
    } finally {vi.unstubAllEnvs();}
  });
  it("pauses the workflow when the SDK continues after a pending tool approval", async () => {
    const requests: UserInputRequest[] = [];
    const chunks: unknown[] = [];
    const iterator = outputNode.stream(createSessionInput(), createNodeContext(requests));

    await expect(async () => {
      for await (const chunk of iterator) {
        chunks.push(chunk);
      }
    }).rejects.toMatchObject({
      name: "HarnessError",
      type: "user_input_required",
      nodeName: "tool-approval",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.metadata).toMatchObject({
      type: "tool-approval",
      toolName: KNOWLEDGE_TOOL,
      toolArguments: { action: "list" },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      type: "output_item_start",
      item: {
        title: expect.stringContaining("knowledge_documents"),
        metadata: { status: "running" },
      },
    });
  });

  it("keeps the approved tool permission decision as a durable output item", async () => {
    const requestId = "claude-agent:run-test:tool-approval:mcp__steamharness-knowledge-documents__knowledge_documents";
    const chunks: unknown[] = [];
    const iterator = outputNode.stream(
      createSessionInput(),
      createNodeContext([], {
        requestId,
        nodeName: "tool-approval",
        values: { approved: true },
        submittedAt: new Date("2026-06-16T00:00:00.000Z"),
      }),
    );

    for await (const chunk of iterator) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "output_item_start",
          item: expect.objectContaining({
            title: "工具权限审批 · Knowledge Documents · 已批准",
            content: expect.stringContaining("结果：已批准"),
            contentType: "markdown",
            collapsed: false,
            metadata: expect.objectContaining({
              kind: "claude-agent-tool-approval",
              tool: "knowledge_documents",
              status: "approved",
              requestId,
            }),
          }),
        }),
      ]),
    );
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "output_item_start",
          item: expect.objectContaining({
            title: expect.stringContaining("knowledge_documents"),
            metadata: expect.objectContaining({ kind: "claude-agent-tool" }),
          }),
        }),
      ]),
    );
  });
});

function createSessionInput(): ClaudeAgentSessionInput {
  return {
    prompt: "List knowledge docs.",
    tools: [KNOWLEDGE_TOOL],
    allowedTools: [],
    permissionMode: "default",
    workdir: process.cwd(),
    model: "mock",
    knowledgeTools: true,
    sessionId: "session-test",
    isResume: false,
  };
}

function createNodeContext(
  requests: UserInputRequest[],
  resolvedInput?: UserInputResolved,
): NodeContext {
  return {
    config: {ANTHROPIC_API_KEY:"fixture-key"},
    providers: {},
    ...createApprovedTestContext(),
    conversation: createDisabledProjectConversationContext(),
    tokenUsage: createDisabledProjectTokenUsageContext(),
    userInput: {
      async getResolvedInput() {
        return resolvedInput;
      },
      async requestInput(request) {
        requests.push(request);
      },
    },
    toolPermissions: createProjectToolPermissionContext({
      projectName: "claude-agent",
      runId: "run-test",
      definitions: [
        {
          name: KNOWLEDGE_TOOL,
          label: "Knowledge Documents",
          description: "Manage project knowledge documents.",
          enabled: true,
          autoApprove: true,
        },
      ],
      policies: {
        [KNOWLEDGE_TOOL]: { autoApprove: false },
      },
    }),
    metadata: {
      project: "claude-agent",
      runId: "run-test",
    },
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
