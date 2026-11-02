import assert from "node:assert/strict";
import { createAgentNode } from "../../agent/node";
import { createAgentConversationProject } from "../../agent/project";
import { BaseStreamNode } from "../../node/base";
import type { OutputItemStreamChunk } from "../../node/output/index";
import { runStreamNode } from "../../workflow/index";
import type { NodeContext } from "../../types/index";

const node = createAgentNode({ tools: [] });
let frames = 0;
const produce = async function* (): AsyncIterable<OutputItemStreamChunk> {
  for (let revision = 0; revision < 600; revision++) {
    // Force independently allocated, growing-history-like session views.
    const content = JSON.parse(JSON.stringify({ revision, turns: [{ text: `${revision}:${"知识".repeat(128_000)}` }] }));
    yield { type: "output_item_start", item: { id: "agent-session", title: "Session", content, contentType: "json", metadata: { kind: "agent-session" } } };
    yield { type: "output_item_end", itemId: "agent-session" };
    if (revision % 100 === 0) {
      yield { type: "output_item_start", item: { id: `text-${revision}`, title: "Text", content: `Retained ${revision}`, contentType: "markdown" } };
      yield { type: "output_item_end", itemId: `text-${revision}` };
    }
  }
};
const input = { errCode: 0, errMessage: "", prompt: "Memory fixture", workdir: process.cwd() };
const context = {
  nodeHooks: { onNodeChunk() { frames++; } },
  conversation: { async appendMessage() {} },
} as unknown as NodeContext;
let output;
if (process.argv.includes("project")) {
  // Replace only the producer in this isolated process. The real convenience
  // project's outer output node must also compact snapshots on runStreamNode.
  BaseStreamNode.prototype.stream = produce;
  output = await createAgentConversationProject({ tools: [] }).run(input, context);
} else {
  node.stream = produce;
  const result = await runStreamNode(node, input, context);
  assert.equal(result.chunks.length, 14);
  output = result.output;
}
assert.equal(frames, 1212);
assert.equal(output?.items.length, 7);
const snapshot = output?.items.find(item => item.id === "agent-session")?.content as { revision: number };
assert.equal(snapshot.revision, 599);
console.log(JSON.stringify({ frames, items: output?.items.length, revision: snapshot.revision }));
