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
import type { NodeContext } from "steamharness/types/context";
import type { PiAgentRunInput, PiAgentSessionFactory, OutputItem } from "../interface";
import { KNOWLEDGE_DOCUMENTS_TOOL_NAME } from "../knowledge-documents-tool";

installWorkflowRuntimeGlobal();

type OutputNodeLike = {
  stream(input: PiAgentRunInput, context: NodeContext): AsyncGenerator<unknown>;
};

let outputNode: OutputNodeLike;

beforeAll(async () => {
  const module = await import("../index");
  outputNode = (module as unknown as { __test_outputNode: OutputNodeLike }).__test_outputNode;
});

describe("pi-agent tool approval stream", () => {
  it("pauses the workflow when a custom tool approval wait is reported by the SDK adapter", async () => {
    let onPendingApproval: ((error: workflow.HarnessError) => void) | undefined;
    const chunks: unknown[] = [];
    const input = createRunInput(async (_sessionInput, hooks) => {
      onPendingApproval = hooks?.onPendingApproval;
      return {
      async *prompt() {
        yield { type: "text_delta", delta: "Before approval. " };
        onPendingApproval?.(createPendingToolApprovalError());
        yield { type: "text_delta", delta: "This text must not render after the pause." };
      },
      getSnapshot() {
        return { activeTools: [KNOWLEDGE_DOCUMENTS_TOOL_NAME] };
      },
      dispose() {},
    };
    });

    await expect(async () => {
      for await (const chunk of outputNode.stream(input, createNodeContext())) {
        chunks.push(chunk);
      }
    }).rejects.toMatchObject({
      name: "HarnessError",
      type: "user_input_required",
      nodeName: "tool-approval",
    });

    const startedItems = chunks.filter(isOutputItemStart);
    expect(startedItems).toHaveLength(1);
    expect(startedItems[0].item).toMatchObject({
      title: "Output",
      content: "",
    });
    expect(chunks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delta: "This text must not render after the pause.",
        }),
      ]),
    );
  });
});

function createRunInput(sessionFactory: PiAgentSessionFactory): PiAgentRunInput {
  return {
    prompt: "执行 knowledge_document list",
    workdir: process.cwd(),
    provider: "anthropic",
    tools: [KNOWLEDGE_DOCUMENTS_TOOL_NAME],
    explicitTools: true,
    knowledgeTools: true,
    dryRun: false,
    sessionFactory,
  };
}

function createPendingToolApprovalError(): workflow.HarnessError {
  return new workflow.HarnessError({
    type: "user_input_required",
    message: `Tool "${KNOWLEDGE_DOCUMENTS_TOOL_NAME}" is waiting for approval.`,
    nodeName: "tool-approval",
    metadata: {
      request: {
        requestId: "pi-agent:pi-agent-stream-test-run:tool-approval:knowledge_documents",
        nodeName: "tool-approval",
        title: "批准工具：Knowledge Documents",
        params: [],
        createdAt: new Date("2026-06-16T00:00:00.000Z"),
        metadata: {
          type: "tool-approval",
          toolName: KNOWLEDGE_DOCUMENTS_TOOL_NAME,
          toolArguments: { action: "list" },
        },
      },
    },
  });
}

function createNodeContext(): NodeContext {
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
    metadata: {
      workflow: "pi-agent",
      runId: "pi-agent-stream-test-run",
    },
    toolPermissions: createWorkflowToolPermissionContext({
      workflowName: "pi-agent",
      runId: "pi-agent-stream-test-run",
      definitions: [
        { name: KNOWLEDGE_DOCUMENTS_TOOL_NAME, enabled: true, autoApprove: false },
      ],
      policies: {
        [KNOWLEDGE_DOCUMENTS_TOOL_NAME]: { autoApprove: false },
      },
    }),
  };
}

function isOutputItemStart(value: unknown): value is { type: "output_item_start"; item: OutputItem } {
  return typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "output_item_start";
}

function createMemoryKVStore(): KVStore {
  const values = new Map<string, unknown>();
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
  };
}
