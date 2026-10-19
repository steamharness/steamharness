import { beforeAll, describe, expect, it } from "vitest";
import {
  createDisabledWorkflowConversationContext,
  createDisabledWorkflowTokenUsageContext,
  createWorkflowRelatedProjectsContext,
  createWorkflowToolPermissionContext,
  type KVContext,
} from "steamharness";
import { installWorkflowRuntimeGlobal } from "steamharness/runtime-api";
import type { NodeContext } from "steamharness/types/context";
import type { PiAgentInput, PiAgentParsedInput } from "../interface";
import { KNOWLEDGE_DOCUMENTS_TOOL_NAME } from "../knowledge-documents-tool";

installWorkflowRuntimeGlobal();

type InputNodeLike = {
  parse(input: PiAgentInput, context: NodeContext): Promise<PiAgentParsedInput>;
};

let parseInputNode: InputNodeLike;

beforeAll(async () => {
  const module = await import("../index");
  parseInputNode = (module as unknown as { __test_inputNode: InputNodeLike }).__test_inputNode;
});

describe("pi-agent input node", () => {
  it("uses the registered default tool allowlist while knowledge tools stay enabled", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs" },
      createNodeContext(),
    );

    expect(parsed.knowledgeTools).toBe(true);
    expect(parsed.explicitTools).toBe(true);
    expect(parsed.tools).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "find",
      "ls",
      KNOWLEDGE_DOCUMENTS_TOOL_NAME,
    ]);
  });

  it("appends the knowledge_documents tool to explicit tool allowlists by default", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs", tools: ["read", "bash"] },
      createNodeContext(),
    );

    expect(parsed.knowledgeTools).toBe(true);
    expect(parsed.explicitTools).toBe(true);
    expect(parsed.tools).toEqual(["read", "bash", KNOWLEDGE_DOCUMENTS_TOOL_NAME]);
  });

  it("does not append or retain the knowledge_documents tool when disabled", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs", tools: ["read", KNOWLEDGE_DOCUMENTS_TOOL_NAME], knowledgeTools: false },
      createNodeContext(),
    );

    expect(parsed.knowledgeTools).toBe(false);
    expect(parsed.explicitTools).toBe(true);
    expect(parsed.tools).toEqual(["read"]);
  });

  it("does not duplicate knowledge_documents when supplied by the user", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs", tools: ["read", KNOWLEDGE_DOCUMENTS_TOOL_NAME] },
      createNodeContext(),
    );

    expect(parsed.tools.filter((tool) => tool === KNOWLEDGE_DOCUMENTS_TOOL_NAME)).toHaveLength(1);
  });

  it("filters registered tools disabled by host policy", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs", tools: ["read", "bash", KNOWLEDGE_DOCUMENTS_TOOL_NAME] },
      createNodeContext({
        bash: { enabled: false },
        [KNOWLEDGE_DOCUMENTS_TOOL_NAME]: { enabled: false },
      }),
    );

    expect(parsed.tools).toEqual(["read"]);
  });
});

function createNodeContext(
  policies: Record<string, { enabled?: boolean; autoApprove?: boolean }> = {},
): NodeContext {
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
    toolPermissions: createWorkflowToolPermissionContext({
      projectName: "pi-agent",
      runId: "pi-agent-test-run",
      definitions: [
        { name: "read", enabled: true, autoApprove: true },
        { name: "write", enabled: true, autoApprove: true },
        { name: "edit", enabled: true, autoApprove: true },
        { name: "bash", enabled: true, autoApprove: true },
        { name: "grep", enabled: true, autoApprove: true },
        { name: "find", enabled: true, autoApprove: true },
        { name: "ls", enabled: true, autoApprove: true },
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
