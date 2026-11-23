import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentOutputPayload } from "../agent/types";
import { runLocalProjectWithReport } from "../executor";
import { testExecutionStorage } from "./runtime-test-storage";

test("a Workflow returns an Agent node's streamed answer without enabling a Bot conversation", async t => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "workflow-agent-"));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  await Promise.all([
    writeFile(path.join(projectDir, "package.json"), JSON.stringify({ type: "module" })),
    writeFile(path.join(projectDir, "steamharness.json"), JSON.stringify({
      name: "Workflow Agent", version: "1.0.0", defaultEntry: "main",
      entries: [{ entryId: "main", name: "Main", type: "workflow", root: ".", entry: "index.ts" }],
    })),
    writeFile(path.join(projectDir, "index.ts"), `
      import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
      const fake = fauxProvider({ models: [{ id: "vision", input: ["text", "image"] }] });
      const models = createModels();
      models.setProvider(fake.provider);
      const frame = { data: "AA==", mimeType: "image/png" };
      const runResponses = [
        request => request.messages.some(message => message.role === "user" && Array.isArray(message.content)
          && message.content.some(block => block.type === "image" && block.data === frame.data && block.mimeType === frame.mimeType))
          ? fauxAssistantMessage([fauxToolCall("runtime_info", {})], { stopReason: "toolUse" })
          : fauxAssistantMessage("Missing image"),
        request => fauxAssistantMessage(request.messages.some(message => message.role === "toolResult"
          && message.toolName === "runtime_info" && !message.isError) ? "Frame processed" : "Missing tool result"),
      ];
      const planResponse = request => {
        const toolNames = request.messages.flatMap(message => message.toolsAdded?.map(tool => tool.name) ?? []);
        return fauxAssistantMessage(toolNames.includes("ask_user") ? "Unexpected ask_user tool" : "1. Inspect the frame");
      };
      const agent = steamharness.createAgentNode({ models, resolvedModel: fake.getModel(), tools: ["runtime_info"], permissionPolicy: "read-only" });
      const workflow = steamharness.defineProject({
        name: "workflow-agent",
        async run(input, context) {
          fake.setResponses(input.agent === "plan" ? [planResponse] : runResponses);
          const originalApprovalPolicy = context.toolPermissions?.requiresUserApproval;
          const { output } = await steamharness.runStreamNode(agent, { ...input, images: [frame] }, context);
          return { ...output, conversationEnabled: context.conversation.enabled, conversationId: context.conversation.conversationId,
            preservedApprovalPolicy: context.toolPermissions?.requiresUserApproval === originalApprovalPolicy };
        },
      });
      export const executor = steamharness.defineExecutor({
        projectType: "workflow",
        defaultEntrypoint: "main",
        entrypoints: [steamharness.defineEntrypoint({
          id: "main", title: "Main", workflow: workflow,
          tools: [{ name: "runtime_info", enabled: true, autoApprove: true }],
          createInput() { return { errCode: 0, errMessage: "", prompt: "Describe the frame", agent: "build" }; },
        }), steamharness.defineEntrypoint({
          id: "plan", title: "Plan", workflow: workflow,
          createInput() { return { errCode: 0, errMessage: "", prompt: "Plan the frame analysis", agent: "plan" }; },
        })],
      });
    `),
  ]);

  const chunkTypes = new Set<string>();
  let inputRequests = 0;
  for (const entrypointId of ["main", "plan"] as const) {
    const report = await runLocalProjectWithReport({
      projectDir, entrypointId, env: {}, storage: testExecutionStorage(), conversationId: "ignored-for-workflow",
      nodeHooks: { onNodeChunk: ({ chunk }) => { chunkTypes.add((chunk as { type: string }).type); } },
      userInput: { getResolvedInput: () => undefined, requestInput: () => { inputRequests++; } },
    });
    assert.equal(report.status, "success", JSON.stringify(report.error ?? report.result));
    assert.ok(report.result.ok);
    const { output } = report.result.data as { output: AgentOutputPayload & { conversationEnabled: boolean; conversationId?: string; preservedApprovalPolicy: boolean } };
    assert.equal(output.errCode, 0);
    assert.equal(output.conversationEnabled, false);
    assert.equal(output.conversationId, undefined);
    assert.equal(output.preservedApprovalPolicy, true);
    if (entrypointId === "main") {
      assert.equal(output.items.filter(item => item.metadata?.partType === "tool" && item.metadata.status === "success").length, 1);
      assert.ok(output.items.some(item => item.content === "Frame processed"));
    } else {
      assert.equal(output.agent, "plan");
      assert.ok(output.items.some(item => item.metadata?.plan === true && item.content === "1. Inspect the frame"));
    }
  }
  assert.equal(inputRequests, 0);
  assert.ok(chunkTypes.has("output_item_delta"));
});
