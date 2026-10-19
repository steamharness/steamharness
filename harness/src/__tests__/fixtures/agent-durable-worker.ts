import path from "node:path";
import { appendFile } from "node:fs/promises";
import * as ai from "@earendil-works/pi-ai";
import { DurableAgent } from "../../agent/durable-agent";

const [directory, scenario, phase] = process.argv.slice(2) as [string, string, string];
const faux = ai.fauxProvider({ models: [{ id: "durable", contextWindow: 100_000, maxTokens: 100 }] });
const models = ai.createModels(); models.setProvider(faux.provider);
const tool = (name: string, replay: "safe" | "never", execute: () => Promise<unknown>) => ({
  name, label: name, description: name, replay, parameters: ai.Type.Object({}),
  execute: async () => { await execute(); return { content: [{ type: "text" as const, text: "ok" }], details: {} }; },
});
const agent = new DurableAgent({
  databasePath: path.join(directory, "session.sqlite"), models,
  initialState: { systemPrompt: "Offline durable test", model: models.getModel("faux", "durable")!,
    thinkingLevel: "off", messages: [], tools: [
      tool("write_once", "never", () => appendFile(path.join(directory, "writes.txt"), "write\n")),
      tool("barrier", scenario === "unsafe" ? "never" : "safe", async () => {
        await appendFile(path.join(directory, "barriers.txt"), "attempt\n");
        if (phase === "initial") {
          setInterval(() => undefined, 1_000);
          process.send?.({ type: "checkpoint" });
          await new Promise<void>(() => undefined);
        }
      }),
    ] },
});
agent.requestId = "logical-input";
const text: string[] = [];
const tools: string[] = [];
agent.subscribe(event => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    text.push(event.assistantMessageEvent.delta);
    if (scenario === "stream" && (phase === "initial" || phase === "reinterrupt" && event.assistantMessageEvent.delta === "Continued ")) process.send?.({ type: "checkpoint" });
  }
  if (event.type === "tool_execution_start") tools.push(event.toolName);
});
if (scenario === "stream" && (phase === "initial" || phase === "reinterrupt")) {
  models.streamSimple = (_model, request) => {
    if (phase === "reinterrupt") process.send?.({ type: "recovered-request", messages: request.messages });
    const stream = ai.createAssistantMessageEventStream();
    const text = phase === "initial" ? "Committed prefix. " : "Continued ";
    const partial = ai.fauxAssistantMessage([ai.fauxText(text), ai.fauxToolCall("write_once", {}, { id: "unfinished-call" })], { stopReason: "pending" });
    stream.push({ type: "start", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
    setInterval(() => undefined, 1_000);
    return stream;
  };
} else if (scenario === "stream" && phase === "budget") {
  faux.setResponses(Array.from({ length: 10 }, () => ai.fauxAssistantMessage("Additional fragment. ", { stopReason: "error", errorMessage: "terminated" })));
} else if (scenario === "stream" && phase === "resume") {
  faux.setResponses([request => {
    process.send?.({ type: "recovered-request", messages: request.messages });
    const continued = request.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Committed prefix. "));
    const restarted = request.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Continued "));
    return ai.fauxAssistantMessage(`${continued ? "" : "Committed prefix. "}${restarted ? "" : "Continued "}answer.`);
  }]);
} else if (phase !== "replay") faux.setResponses(phase === "initial" ? [ai.fauxAssistantMessage([
  ...(scenario === "unsafe" ? [] : [ai.fauxToolCall("write_once", {}, { id: "write" })]),
  ai.fauxToolCall("barrier", {}, { id: "barrier" }),
], { stopReason: "toolUse" })] : [request => {
  const result = request.messages.find(message => message.role === "toolResult" && message.toolCallId === "barrier");
  process.send?.({ type: "recovered-result", result });
  return ai.fauxAssistantMessage("Recovered answer");
}]);
try {
  await agent.prompt("Do the task");
  process.send?.({ type: "done", text: text.join(""), calls: faux.state.callCount, tools, errorMessage: agent.state.errorMessage });
} finally { await agent.close(); process.disconnect?.(); }
