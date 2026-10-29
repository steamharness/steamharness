import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as ai from "@earendil-works/pi-ai";
import {
  createLocalProjectKVStore, createProjectKVContext, createProjectConversationContext,
  createProjectToolPermissionContext, createProjectTokenUsageContext, TOKEN_USAGE_TOTAL_KEY,
  type RunContext, type ConversationExecutorDefinition, type AgentInput, type AgentOutputPayload, type AgentProjectOptions,
  type UserInputResolved,
} from "steamharness";
import { installProjectRuntimeGlobal } from "steamharness/runtime-api";
import { createAgentSessionHost, controlAgentSession, type AgentSessionSnapshot } from "steamharness/agent";

const [directory, scenario, phase] = process.argv.slice(2) as [string, string, string];
const faux = ai.fauxProvider({ models: [{ id: "fixture", contextWindow: 100_000, maxTokens: 1_000 }],
  ...(scenario === "blocks" ? { tokensPerSecond: 100, tokenSize: { min: 8, max: 8 } } : {}),
});
const models = ai.createModels(); models.setProvider(faux.provider);
// Core's bundled declarations own the transcript brand; this fixture pins the same upstream runtime.
const injectedModels = models as unknown as NonNullable<AgentProjectOptions["models"]>;
const runtime = installProjectRuntimeGlobal();
const registry = runtime.createAgentRegistry();
const timer = runtime.defineAgentTask<{ wakeAt: number }, { phase: "sleep"; wakeAt: number }, string>({ name: "fixture.timer", version: 1,
  initial: input => ({ phase: "sleep", wakeAt: input.wakeAt }), phases: { sleep: async (task, api, ctx) => {
    await api.sleep(task.state.checkpoint.wakeAt, ctx);
    await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: "awake" } }), ctx);
  } }, abort: async (_task, api, ctx) => { await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx); } });
registry.install(runtime.defineAgentExtension({ name: "fixture", tasks: [timer] }));
let scriptWaiting = false;
// Keep the real assistant declaration, persona, tools and nodes; only the model is scripted.
globalThis.steamharness = { ...runtime, createAgentConversationProject: options => runtime.createAgentConversationProject({
  ...options, models: injectedModels, resolvedModel: models.getModel("faux", "fixture")!,
  ...(scenario === "extensions" ? { session: { ...options?.session, codeMode: {}, registry, nativeTools: [{ name: "checkpoint", description: "Fixture restart barrier", replay: "safe" as const,
    parameters: ai.Type.Object({}), execute: async () => { scriptWaiting = true;
      if (phase === "initial") return new Promise(() => undefined);
      return { output: [{ type: "text" as const, text: "Resumed checkpoint" }] };
    } }] } } : {}),
}) };
const { executor: declaration } = await import("../../index");
const executor = declaration as ConversationExecutorDefinition<AgentInput, AgentOutputPayload>;
const projectId = "durable-assistant", conversationId = scenario, projectName = "developer-assistant";
const runId = phase === "fresh" ? "fresh-run" : "original-run";
const host = ["session", "extensions", "blocks", "approval-session", "skill-recovery"].includes(scenario) ? createAgentSessionHost(conversationId) : undefined;
const keepAlive = host ? setInterval(() => undefined, 1_000) : undefined;
let sessionSnapshot: AgentSessionSnapshot | undefined;
let childTools: string[] = [];
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Assistant session did not settle."); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const kv = createProjectKVContext({ store: createLocalProjectKVStore({ rootDir: path.join(directory, "kv") }), projectId, conversationId });
const conversation = createProjectConversationContext({ enabled: true, projectName, conversationId, kv });
const tokenUsage = createProjectTokenUsageContext({ kv, projectId, conversationId, runId, definition: executor.tokenUsage });
let decisions: UserInputResolved[] = [];
try { decisions = JSON.parse(await readFile(path.join(directory, "decisions.json"), "utf8")); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const userInput = {
  getResolvedInput: async (id: string) => decisions.find(decision => decision.requestId === id),
  requestInput: async () => undefined,
};
const context = {
  metadata: { project: projectName, runId, agentStoreDir: path.join(directory, "agents") },
  providers: {}, storage: { local: { kv, persistentValue: kv }, server: { kv, persistentValue: kv } },
  conversation, tokenUsage, userInput,
  toolPermissions: createProjectToolPermissionContext({ definitions: [...(executor.tools ?? []), ...(scenario === "extensions" ? [{ name: "checkpoint", enabled: true, autoApprove: true }] : [])], projectName, runId, userInput }),
  nodeHooks: {
    onNodeChunk(event: { chunk: Record<string, unknown> }) {
      if (event.chunk.type === "output_item_start" && (event.chunk.item as { metadata?: { kind?: string } })?.metadata?.kind === "agent-session") sessionSnapshot = (event.chunk.item as { content: AgentSessionSnapshot }).content;
      if (scenario === "stream" && phase === "initial" && event.chunk.type === "output_item_delta" && event.chunk.delta === "Durable assistant ") {
        process.send?.({ type: "checkpoint" });
      }
    },
  },
} as unknown as RunContext;
const executorContext = {
  projectName, projectDir: path.resolve(import.meta.dirname, "../.."), config: {}, abortSignal: new AbortController().signal,
  args: ["--message", scenario === "session" ? "Delegate background inspection" : "Create recovered.txt after checking the plan"],
  paramValues: { provider: "faux", model: "fixture", plan: scenario.startsWith("approval") ? "true" : "false" },
} as Parameters<typeof executor.createInput>[0];
const input = await executor.createInput(executorContext);
const extraContext = await executor.createContext?.(executorContext);
Object.assign(context.metadata!, extraContext?.metadata);
const write = ai.fauxAssistantMessage([ai.fauxToolCall("write", { path: "recovered.txt", content: "created" }, { id: "write-once" })], { stopReason: "toolUse" });
if (scenario === "skill-recovery" && phase !== "replay") {
  const original = await readFile(path.resolve(import.meta.dirname, "../../skills/steamharness-generator/SKILL.md"), "utf8");
  const respond = (request: ai.TranscriptContext): ai.AssistantMessage => {
    const results = request.messages.filter(message => message.role === "toolResult");
    const child = request.messages.some(message => message.role === "user" && message.content === "Read bundled skill tail");
    if (child) {
      childTools = [...new Set(request.messages.flatMap(message => message.role === "system" ? message.toolsAdded?.map(tool => tool.name) ?? [] : []))].sort();
      assert.ok(childTools.includes("skill"));
      assert.ok(!childTools.includes("bash") && !childTools.includes("write") && !childTools.includes("subagent"));
    }
    const pages = results.filter(message => message.toolName === "skill").map(message => {
      assert.ok(!message.isError);
      const body = message.content.filter(block => block.type === "text").map(block => block.text).join("");
      assert.ok(Buffer.byteLength(body) <= 40_000);
      return JSON.parse(body) as { content: string; truncated: boolean; nextOffset?: number };
    });
    if (!pages.length || pages.at(-1)!.truncated) return ai.fauxAssistantMessage([ai.fauxToolCall("skill", {
      action: "read", skill: "steamharness-generator", offset: pages.at(-1)?.nextOffset ?? (child ? original.length - 1_000 : 0),
    })], { stopReason: "toolUse" });
    const content = pages.map(page => page.content).join("");
    if (child) {
      assert.equal(content, original.slice(-1_000));
      return ai.fauxAssistantMessage("Bundled skill tail verified");
    }
    assert.equal(content, original);
    if (!results.some(message => message.toolName === "subagent")) return ai.fauxAssistantMessage([
      ai.fauxToolCall("subagent", { task: "Read bundled skill tail" }),
    ], { stopReason: "toolUse" });
    assert.match(JSON.stringify(results.find(message => message.toolName === "subagent")), /Bundled skill tail verified/);
    const cards = results.filter(message => message.toolName === "workflow-ui_present_card");
    if (!cards.length) return ai.fauxAssistantMessage([ai.fauxToolCall("workflow-ui_present_card", {
      action: "upsert", cardId: "readme", kind: "file", target: { source: "current", path: "README.md" }, preview: false,
    })], { stopReason: "toolUse" });
    if (cards.length === 1) {
      assert.ok(cards[0]!.isError);
      assert.match(JSON.stringify(cards[0]), /target.path|filePath/);
      return ai.fauxAssistantMessage([ai.fauxToolCall("workflow-ui_present_card", {
        action: "upsert", cardId: "readme", kind: "file", target: { source: "current", filePath: "README.md" }, preview: false,
      })], { stopReason: "toolUse" });
    }
    assert.ok(!cards.at(-1)!.isError);
    if (!results.some(message => message.toolName === "write")) return write;
    assert.ok(!results.find(message => message.toolName === "write")!.isError);
    return ai.fauxAssistantMessage("Skill read, delegation, card recovery and implementation completed in one turn.");
  };
  faux.setResponses(Array.from({ length: 30 }, () => respond));
} else if (scenario === "blocks" && phase !== "replay") {
  faux.setResponses([ai.fauxAssistantMessage([
    { type: "thinking", thinking: "Inspect the fixture before answering. Keep the thought, explanation and tool arguments in separate streamed blocks." },
    ai.fauxText("I will inspect the fixture. "), ai.fauxToolCall("read", { path: "inspected.md" }),
  ], { stopReason: "toolUse" }), request => {
    assert.match(JSON.stringify(request.messages.find(message => message.role === "toolResult" && message.toolName === "read")), /streamed fixture/);
    return ai.fauxAssistantMessage("Inspection complete.");
  }]);
} else if (scenario === "extensions" && phase === "initial") {
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("codemode", { code: 'text(await tools.write({ path: "recovered.txt", content: "created" })); text(await tools.checkpoint({}));' })], { stopReason: "toolUse" })]);
} else if (scenario === "extensions" && phase === "resume") {
  faux.setResponses([request => { assert.match(JSON.stringify(request.messages), /Resumed checkpoint/); return ai.fauxAssistantMessage("Code Mode recovered."); }]);
} else if (scenario === "session" && phase !== "replay") {
  const response = async (request: ai.TranscriptContext): Promise<ai.AssistantMessage> => {
    const lastUser = [...request.messages].reverse().find(message => message.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content : "";
    if (text === "Inspect inspected.md") {
      childTools = [...new Set(request.messages.flatMap(message => message.role === "system" ? message.toolsAdded?.map(tool => tool.name) ?? [] : []))].sort();
      const read = request.messages.find(message => message.role === "toolResult" && message.toolName === "read");
      if (!read) return ai.fauxAssistantMessage([ai.fauxToolCall("read", { path: "inspected.md" })], { stopReason: "toolUse" });
      assert.match(JSON.stringify(read), /durable inspection fixture/);
      if (phase === "initial") {
        await until(() => !!sessionSnapshot?.turns.some(turn => turn.status === "done" && !turn.requestId.startsWith("delegate:"))
          && !!sessionSnapshot?.history.some(task => task.toolName === "read" && task.status === "completed"));
        process.send?.({ type: "checkpoint", snapshot: sessionSnapshot, childTools });
        setInterval(() => undefined, 1_000);
        return new Promise(() => undefined);
      }
      return ai.fauxAssistantMessage("Inspection complete");
    }
    if (text.startsWith("Subagent result")) return ai.fauxAssistantMessage("Background result received");
    if (text === "Follow up") return ai.fauxAssistantMessage("Follow up complete");
    if (text === "Fork follow up") return ai.fauxAssistantMessage("Fork complete");
    if (!request.messages.some(message => message.role === "toolResult" && message.toolName === "update_plan")) return ai.fauxAssistantMessage([
      ai.fauxToolCall("update_plan", { items: [{ id: "inspect", text: "Inspect the fixture", status: "in_progress" }] }),
    ], { stopReason: "toolUse" });
    if (!request.messages.some(message => message.role === "toolResult" && message.toolName === "subagent")) return ai.fauxAssistantMessage([
      ai.fauxToolCall("subagent", { task: "Inspect inspected.md", background: true }),
    ], { stopReason: "toolUse" });
    return ai.fauxAssistantMessage("Foreground complete");
  };
  faux.setResponses(Array.from({ length: 12 }, () => response));
} else if (scenario === "stream" && phase === "initial") {
  models.streamSimple = () => {
    const stream = ai.createAssistantMessageEventStream();
    const partial = ai.fauxAssistantMessage("Durable assistant ", { stopReason: "pending" });
    stream.push({ type: "start", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "Durable assistant ", partial });
    setInterval(() => undefined, 1_000);
    return stream;
  };
} else if (scenario === "stream" && phase === "resume") {
  faux.setResponses([request => {
    assert.ok(request.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Durable assistant ")));
    assert.match(String(request.messages.at(-1)?.content), /agent host restarted/);
    return ai.fauxAssistantMessage("continued after interruption.");
  }]);
} else if (scenario === "crash" && phase === "initial") {
  faux.setResponses([write, async () => {
    process.send?.({ type: "checkpoint" });
    setInterval(() => undefined, 1_000);
    return new Promise<ai.AssistantMessage>(() => undefined);
  }]);
} else if (scenario === "crash" && phase === "resume") {
  faux.setResponses([request => {
    assert.ok(request.messages.some(message => message.role === "toolResult" && message.toolCallId === "write-once" && !message.isError));
    return ai.fauxAssistantMessage("Durable assistant completed.");
  }]);
} else if (phase === "plan") {
  faux.setResponses([ai.fauxAssistantMessage("A seven-day reading plan.")]);
} else if (phase === "revise") {
  faux.setResponses([ai.fauxAssistantMessage("A thirty-day reading plan.")]);
} else if (phase === "ask") {
  faux.setResponses([ai.fauxAssistantMessage([ai.fauxToolCall("ask_user", {
    questions: [{ question: "Which file?", options: [{ label: "recovered.txt" }] }],
  }, { id: "ask-file" })], { stopReason: "toolUse" })]);
} else if (phase === "answer") {
  faux.setResponses([ai.fauxAssistantMessage("I will create recovered.txt.")]);
} else if (phase === "approve") {
  faux.setResponses([write, ai.fauxAssistantMessage("Approved task completed.")]);
} else if (phase === "fresh") {
  faux.setResponses([ai.fauxAssistantMessage("A fresh plan.")]);
}
try {
  const running = executor.workflow.run(input, context);
  if (scenario === "blocks" || scenario === "skill-recovery") {
    await until(() => !!sessionSnapshot?.turns.some(turn => turn.conversationId === sessionSnapshot!.conversationId && turn.status === "done") && sessionSnapshot.tasks.length === 0);
    host!.close();
  }
  if (scenario === "approval-session" && ["approve", "replay"].includes(phase)) {
    await until(() => !!sessionSnapshot?.turns.some(turn => turn.requestId.endsWith(`:plan:${decisions.at(-1)!.requestId}`) && turn.status === "done"));
    host!.close();
  }
  if (scenario === "extensions") {
    if (phase === "initial") {
      await until(() => scriptWaiting);
      await controlAgentSession(conversationId, { type: "task", name: "fixture.timer", requestId: "timer", input: { wakeAt: Date.now() + 1000 }, background: true });
      await until(() => !!sessionSnapshot?.tasks.some(task => task.kind === "fixture.timer" && task.wakeAt));
      process.send?.({ type: "checkpoint", snapshot: sessionSnapshot });
    } else {
      await until(() => !!sessionSnapshot?.turns.some(turn => turn.status === "done") && !!sessionSnapshot?.history.some(task => task.kind === "fixture.timer" && task.status === "completed"));
      host!.close();
    }
  }
  if (scenario === "session" && phase !== "initial") {
    await until(() => !!sessionSnapshot?.turns.some(turn => turn.requestId.startsWith("report:") && turn.status === "done"));
    const initial = sessionSnapshot!.turns.find(turn => !/^(delegate:|report:|session-)/.test(turn.requestId))!;
    const plan = { type: "plan" as const, requestId: "session-plan", expectedVersion: 1, items: [{ id: "inspect", text: "Inspect the fixture", status: "completed" as const }] };
    await controlAgentSession(conversationId, plan); await controlAgentSession(conversationId, plan);
    const fork = await controlAgentSession(conversationId, { type: "fork", requestId: "session-fork", entryId: initial.answerId! });
    await controlAgentSession(conversationId, { type: "submit", requestId: "session-fork-input", targetId: fork.forkId, prompt: "Fork follow up", mode: "followUp" });
    await controlAgentSession(conversationId, { type: "reset", requestId: "session-reset", handoff: "Inspection finished" });
    const followUp = { type: "submit" as const, requestId: "session-follow-up", prompt: "Follow up", mode: "followUp" as const };
    await controlAgentSession(conversationId, followUp); await controlAgentSession(conversationId, followUp);
    await until(() => !!sessionSnapshot?.turns.some(turn => turn.requestId === "session-follow-up" && turn.status === "done")
      && !!sessionSnapshot?.turns.some(turn => turn.requestId === "session-fork-input" && turn.status === "done"));
    host!.close();
  }
  const output = await running;
  const result = { type: "done", output, calls: faux.state.callCount,
    conversation: await conversation.getValue(), usage: await kv.getValue(TOKEN_USAGE_TOTAL_KEY), snapshot: sessionSnapshot, childTools };
  // Skill pages make this fixture larger than the IPC channel's high-water
  // mark. Flush the message before disconnecting the worker.
  await new Promise<void>((resolve, reject) => process.send!(result, error => error ? reject(error) : resolve()));
} catch (pause) {
  if ((pause as { type?: string }).type !== "user_input_required") throw pause;
  process.send?.({ type: "waiting", request: (pause as { metadata?: { request?: unknown } }).metadata?.request, calls: faux.state.callCount, snapshot: sessionSnapshot });
} finally { clearInterval(keepAlive); host?.close(); process.disconnect?.(); }
