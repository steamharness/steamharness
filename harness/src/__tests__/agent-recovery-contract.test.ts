import assert from "node:assert/strict";
import test from "node:test";
import { createAgentConversationProject, createAgentProjectInput } from "../agent/project";
import { defineProjectExecutor } from "../executor/definition";
import { analyzeProjectScriptSource } from "../executor/rules";

test("selected Core Agent projects inherit recovery while preserving presentation declarations", () => {
  const core = createAgentConversationProject({ tools: [] });
  for (const wrapped of [false, true]) {
    const executor = defineProjectExecutor({ projectType: "conversation", workflow: core,
      ...(wrapped ? { coreAgent: core } : {}), conversation: { inputQueue: { enabled: true }, attachments: { images: true } },
      createInput: createAgentProjectInput });
    assert.equal(executor.projectType, "conversation");
    if (executor.projectType !== "conversation") return;
    assert.deepEqual(executor.conversation, { recovery: { enabled: true }, inputQueue: { enabled: true }, attachments: { images: true } });
  }
});

test("static recovery follows the selected Agent, including wrappers with explicit parameters", () => {
  for (const wrapped of [false, true]) for (const declaration of ["", "conversation: { inputQueue: { enabled: true } }, params: [],"]) {
    const source = `
      throw new Error("Static inspection must not execute project code");
      const core = steamharness.createAgentConversationProject({ tools: [] });
      const business = steamharness.defineProject({ name: "business", run(input, context) { return core.run(input, context); } });
      export const executor = steamharness.defineExecutor({ projectType: "conversation",
        workflow: ${wrapped ? "business, coreAgent: core" : "core"}, ${declaration} createInput: steamharness.createAgentProjectInput });`;
    const report = analyzeProjectScriptSource(source);
    assert.deepEqual(report.executorConfigurationViolations, []);
    assert.deepEqual(report.executorConversation?.recovery, { enabled: true });
    assert.equal(report.executorConversation?.durable, undefined);
    if (declaration) assert.deepEqual(report.executorConversation?.inputQueue, { enabled: true });
  }
  const report = analyzeProjectScriptSource(`
    const unrelated = steamharness.createAgentConversationProject();
    const workflow = steamharness.defineProject({ name: "ordinary", run(input) { return input; } });
    export const executor = steamharness.defineExecutor({ projectType: "conversation", workflow, createInput: steamharness.createAgentProjectInput });`);
  assert.equal(report.executorConversation?.recovery, undefined);
});
