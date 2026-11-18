import assert from "node:assert/strict";
import test from "node:test";
import { defineBot } from "../agent/bot";
import { analyzeProjectScriptSource } from "../executor/rules";

test("Bot runtime and static inspection share mandatory capabilities and manual recovery", () => {
  for (const startup of ["automatic", "manual"] as const) {
    const bot = defineBot({ engine: "agent", conversation: { recovery: { startup } } });
    const report = analyzeProjectScriptSource(`export const executor = steamharness.defineBot({ engine: "agent", conversation: { recovery: { startup: "${startup}" } } });`);
    assert.deepEqual(report.executorConfigurationViolations, []);
    assert.deepEqual(report.executorConversation, bot.conversation);
    assert.deepEqual(report.executorTokenUsage, bot.tokenUsage);
    assert.equal(bot.conversation?.durable?.enabled, true);
    assert.equal(bot.conversation?.inputQueue?.enabled, true);
    assert.deepEqual(bot.conversation?.openai, { enabled: true, outputItemId: "agent-answer" });
  }
});

test("mandatory host capabilities cannot be overridden", () => {
  for (const key of ["durable", "inputQueue", "openai"]) {
    assert.throws(() => defineBot({ engine: "agent", conversation: { [key]: { enabled: false } } as never }), /owned by Core/);
  }
  assert.throws(() => defineBot({ engine: "agent", conversation: { recovery: { enabled: false } } as never }), /always enabled/);
});

test("static Bot tools include configured Core capabilities", () => {
  const agent = { tools: [] as string[], skills: { directories: ["skills"] }, session: { subagents: { tools: ["read"] }, toolSearch: {}, codeMode: {} } };
  const bot = defineBot({ engine: "agent", agent });
  const report = analyzeProjectScriptSource(`export const executor = steamharness.defineBot({ engine: "agent", agent: ${JSON.stringify(agent)} });`);
  assert.deepEqual(report.executorTools, bot.tools);
});
