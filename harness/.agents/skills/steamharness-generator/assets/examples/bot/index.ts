import type { RuntimeApi } from "steamharness/runtime-api";
declare const steamharness: RuntimeApi;

export const executor = steamharness.defineBot({
  name: "assistant",
  agent: { systemPrompt: "你是项目助手。依据实际工具结果回答，遵守当前权限。" },
  conversation: {
    commands: [
      { command: "export", label: "导出会话", action: { kind: "export" } },
      { command: "compact", label: "总结上下文", action: { kind: "prompt", text: "/compact" } },
    ],
    footer: [{ text: "Plan 模式", when: { param: "plan", value: "true" } }],
    userInput: { effects: [{ when: { type: "agent-plan-approval", values: { decision: "approve" } }, params: { plan: "false" } }] },
  },
});
export default executor;
