import { createApprovedTestContext } from "../../../test-databases";
import { beforeAll, describe, expect, it } from "vitest";
import { installProjectRuntimeGlobal } from "steamharness/runtime-api";
import {
  createDisabledProjectConversationContext,
  createDisabledProjectTokenUsageContext,
  createProjectToolPermissionContext,
  type KVContext,
} from "steamharness";
import type { NodeContext } from "steamharness/types/context";
import type { ClaudeAgentInput, ClaudeAgentParsedInput } from "../interface";

installProjectRuntimeGlobal();

const EXPECTED_KNOWLEDGE_TOOL =
  "mcp__steamharness-knowledge-documents__knowledge_documents";

type InputNodeLike = {
  parse(input: ClaudeAgentInput, context: NodeContext): Promise<ClaudeAgentParsedInput>;
};
type CanUseToolLike = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    toolUseID: string;
    displayName?: string;
  },
) => Promise<
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string }
>;

let parseInputNode: InputNodeLike;
let createCanUseTool: (context: NodeContext) => CanUseToolLike;

beforeAll(async () => {
  const module = await import("../index");
  parseInputNode = (module as unknown as { __test_inputNode: InputNodeLike }).__test_inputNode;
  createCanUseTool = (module as unknown as {
    __test_createCanUseTool: (context: NodeContext) => CanUseToolLike;
  }).__test_createCanUseTool;
});

describe("claude-agent input node", () => {
  it("appends the knowledge_documents MCP tool to allowedTools by default", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs" },
      createNodeContext(),
    );

    expect(parsed.knowledgeTools).toBe(true);
    expect(parsed.tools).toEqual(
      expect.arrayContaining(["Read", "Edit", "Glob", "Grep", "Bash", EXPECTED_KNOWLEDGE_TOOL]),
    );
    expect(parsed.allowedTools).toEqual(
      expect.arrayContaining(["Read", "Edit", "Glob", "Grep", "Bash", EXPECTED_KNOWLEDGE_TOOL]),
    );
  });

  it("does not add the knowledge_documents MCP tool when knowledgeTools is false", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs", knowledgeTools: false },
      createNodeContext(),
    );

    expect(parsed.knowledgeTools).toBe(false);
    expect(parsed.tools).not.toContain(EXPECTED_KNOWLEDGE_TOOL);
    expect(parsed.allowedTools).not.toContain(EXPECTED_KNOWLEDGE_TOOL);
    expect(parsed.allowedTools).toEqual(
      expect.arrayContaining(["Read", "Edit", "Glob", "Grep", "Bash"]),
    );
  });

  it("preserves user-supplied tools and only appends the MCP tool", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs", allowedTools: ["WebFetch", "Bash"] },
      createNodeContext(),
    );

    expect(parsed.knowledgeTools).toBe(true);
    expect(parsed.tools).toEqual(
      expect.arrayContaining(["WebFetch", "Bash", EXPECTED_KNOWLEDGE_TOOL]),
    );
    expect(parsed.allowedTools).toEqual(
      expect.arrayContaining(["WebFetch", "Bash", EXPECTED_KNOWLEDGE_TOOL]),
    );
    expect(parsed.allowedTools).not.toContain("Read");
  });

  it("does not duplicate the MCP tool if it is already in the user list", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs", allowedTools: ["Read", EXPECTED_KNOWLEDGE_TOOL] },
      createNodeContext(),
    );

    const occurrences = parsed.allowedTools.filter((t) => t === EXPECTED_KNOWLEDGE_TOOL).length;
    expect(occurrences).toBe(1);
  });

  it("filters registered tools disabled by host policy", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs", allowedTools: ["WebFetch", "Bash", EXPECTED_KNOWLEDGE_TOOL] },
      createNodeContext({
        Bash: { enabled: false },
        [EXPECTED_KNOWLEDGE_TOOL]: { enabled: false },
      }),
    );

    expect(parsed.allowedTools).toEqual(["WebFetch"]);
    expect(parsed.tools).toEqual(["WebFetch"]);
  });

  it("keeps manually approved tools available while removing them from auto-allowed tools", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs", allowedTools: ["Write", "Bash", "ReadMcpResource"] },
      createNodeContext({
        Bash: { autoApprove: false },
        ReadMcpResource: { autoApprove: false },
      }),
    );

    expect(parsed.tools).toEqual(["Write", "Bash", "ReadMcpResource", EXPECTED_KNOWLEDGE_TOOL]);
    expect(parsed.allowedTools).toEqual(["Write", EXPECTED_KNOWLEDGE_TOOL]);
  });

  it("uses default permission mode when any registered tool requires workflow approval", async () => {
    const parsed = await parseInputNode.parse(
      { prompt: "list docs", permissionMode: "bypassPermissions" },
      createNodeContext({
        Bash: { autoApprove: false },
      }),
    );

    expect(parsed.permissionMode).toBe("default");
  });

  it("maps Claude canUseTool decisions through workflow tool approval", async () => {
    const allow = await createCanUseTool(createNodeContext())("Bash", { command: "pwd" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu-allow",
      displayName: "Run shell command",
    });
    expect(allow).toEqual({ behavior: "allow", updatedInput: { command: "pwd" } });

    const deny = await createCanUseTool(createNodeContext({ Bash: { enabled: false } }))("Bash", { command: "pwd" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu-deny",
    });
    expect(deny).toMatchObject({ behavior: "deny" });

    await expect(createCanUseTool(createNodeContext({ Bash: { autoApprove: false } }))("Bash", { command: "pwd" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu-wait",
    })).rejects.toMatchObject({
      name: "HarnessError",
      type: "user_input_required",
    });
  });

  it("returns a valid Claude allow decision after workflow approval resumes", async () => {
    const approved = await createCanUseTool(createNodeContext(
      { Bash: { autoApprove: false } },
      {
        requestId: "claude-agent:claude-agent-test-run:tool-approval:Bash",
        nodeName: "tool-approval",
        values: { approved: true },
        submittedAt: new Date("2026-06-16T00:00:00.000Z"),
      },
    ))("Bash", { command: "pwd" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu-approved",
    });

    expect(approved).toEqual({
      behavior: "allow",
      updatedInput: { command: "pwd" },
    });
  });
});

function createNodeContext(
  policies: Record<string, { enabled?: boolean; autoApprove?: boolean }> = {},
  resolvedInput?: {
    requestId: string;
    nodeName: string;
    values: Record<string, unknown>;
    submittedAt: Date;
  },
): NodeContext {
  return {
    providers: {},
    ...createApprovedTestContext(),
    conversation: createDisabledProjectConversationContext(),
    tokenUsage: createDisabledProjectTokenUsageContext(),
    userInput: {
      async getResolvedInput() {
        return resolvedInput;
      },
      async requestInput() {},
    },
    toolPermissions: createProjectToolPermissionContext({
      projectName: "claude-agent",
      runId: "claude-agent-test-run",
      definitions: [
        { name: "Read", enabled: true, autoApprove: true },
        { name: "Write", enabled: true, autoApprove: true },
        { name: "Edit", enabled: true, autoApprove: true },
        { name: "MultiEdit", enabled: true, autoApprove: true },
        { name: "Glob", enabled: true, autoApprove: true },
        { name: "Grep", enabled: true, autoApprove: true },
        { name: "LS", enabled: true, autoApprove: true },
        { name: "Bash", enabled: true, autoApprove: true },
        { name: "BashOutput", enabled: true, autoApprove: true },
        { name: "KillBash", enabled: true, autoApprove: true },
        { name: "WebFetch", enabled: true, autoApprove: true },
        { name: "WebSearch", enabled: true, autoApprove: true },
        { name: "Task", enabled: true, autoApprove: true },
        { name: "ExitPlanMode", enabled: true, autoApprove: true },
        { name: "ListMcpResources", enabled: true, autoApprove: true },
        { name: "ReadMcpResource", enabled: true, autoApprove: true },
        { name: "NotebookRead", enabled: true, autoApprove: true },
        { name: "NotebookEdit", enabled: true, autoApprove: true },
        { name: "TodoRead", enabled: true, autoApprove: true },
        { name: "TodoWrite", enabled: true, autoApprove: true },
        { name: "AskUserQuestion", enabled: true, autoApprove: true },
        { name: "EnterWorktree", enabled: true, autoApprove: true },
        { name: "ExitWorktree", enabled: true, autoApprove: true },
        { name: EXPECTED_KNOWLEDGE_TOOL, enabled: true, autoApprove: true },
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
