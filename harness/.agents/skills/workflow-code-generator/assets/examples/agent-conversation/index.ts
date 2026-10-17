import type { AgentInput, AgentOutputPayload } from "workflow-code";
import type { WorkflowRuntimeApi } from "workflow-code/runtime-api";

// Start from a Conversation scaffold. The host installs this global at runtime.
const workflow = globalThis.workflow as WorkflowRuntimeApi | undefined;
if (workflow === undefined) throw new Error("The workflow runtime is not installed.");

const agentWorkflow = workflow.createAgentConversationWorkflow({
  workflowName: "assistant",
  outputItemId: "assistant-answer",
});

export const executor = workflow.defineExecutor<AgentInput, AgentOutputPayload>({
  projectType: "conversation",
  workflow: agentWorkflow,
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
  params: [
    { kind: "auxiliary", id: "workspace", label: "工作目录", fields: [
      { name: "workdir", flag: "--workdir", type: "string", defaultValue: "." },
    ] },
    { kind: "quick", id: "ai", label: "AI", summary: ["model"], fields: [
      { name: "provider", flag: "--provider", type: "string", control: "select", required: true, options: [] },
      { name: "model", flag: "--model", type: "string", control: "select", required: true, options: [] },
    ] },
    { kind: "slash", name: "plan", flag: "--plan", type: "boolean", label: "Plan", defaultValue: "false" },
  ],
  resolveParams: workflow.createAgentProjectParamResolver(),
  createInput({ args, paramValues }) {
    return { ...workflow.createAgentProjectInput(args), agent: paramValues.plan === "true" ? "plan" : "build" };
  },
});

export default agentWorkflow;
