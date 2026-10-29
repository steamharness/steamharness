import type { AgentInput, AgentOutputPayload } from "steamharness";
import type { RuntimeApi } from "steamharness/runtime-api";

// Start from a Conversation scaffold. The host installs this global at runtime.
const steamharness = globalThis.steamharness as RuntimeApi | undefined;
if (steamharness === undefined) throw new Error("The workflow runtime is not installed.");

const agentProject = steamharness.createAgentConversationProject({
  executorName: "assistant",
  outputItemId: "assistant-answer",
});

export const executor = steamharness.defineExecutor<AgentInput, AgentOutputPayload>({
  projectType: "conversation",
  workflow: agentProject,
  conversation: {
    recovery: { enabled: true },
    commands: [
      { command: "export", label: "Export conversation", action: { kind: "export" } },
      { command: "compact", label: "Summarize context", action: { kind: "prompt", text: "/compact" } },
    ],
    footer: [{ text: "Plan mode", localizedText: { "zh-CN": "Plan 模式" }, when: { param: "plan", value: "true" } }],
    userInput: { effects: [{ when: { type: "agent-plan-approval", values: { decision: "approve" } }, params: { plan: "false" } }] },
    inputQueue: { enabled: true },
    openai: { enabled: true, outputItemId: "assistant-answer" },
  },
  tokenUsage: { enabled: true, display: true },
  tools: [
    { name: "read", label: "Read", enabled: true, autoApprove: true },
    { name: "write", label: "Write", enabled: true, autoApprove: true },
    { name: "edit", label: "Edit", enabled: true, autoApprove: true },
    { name: "bash", label: "Shell", enabled: true, autoApprove: true },
    { name: "grep", label: "Search", enabled: true, autoApprove: true },
    { name: "find", label: "Find", enabled: true, autoApprove: true },
    { name: "ls", label: "List", enabled: true, autoApprove: true },
  ],
  createInput(context) {
    return steamharness.createAgentProjectInput(context);
  },
});

export default agentProject;
