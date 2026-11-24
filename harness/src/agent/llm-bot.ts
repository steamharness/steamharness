import { createHash, randomUUID } from "node:crypto";
import type { ConversationMessageContract } from "../conversation/index";
import { readOpenAIConversationHostInput, type OpenAIConversationHostInput } from "../executor/openai";
import type { BotExecutorDefinition, BotParamDeclaration, ConversationDefinition, ExecutorContext } from "../executor/types";
import { createOutputNode, createOutputPayload, type OutputItem } from "../node/output/index";
import { createLLMProvider, type LLMImagePart, type LLMMessage, type LLMProvider, type LLMUsage } from "../provider/llm/index";
import { PiAiLLMProvider, type LLMBotToolRound } from "../provider/llm/pi-ai";
import { observeLLMBotModelRequest } from "../provider/llm/request-trace";
import type { LLMChatInput } from "../provider/llm/types";
import type { NodeContext } from "../types/index";
import { defineProject, runStreamNode } from "../workflow/index";
import { HarnessError } from "../workflow/errors";
import { deepFreezeBotOutput, replayBotOutput, type BotDefinition, type BotLLMOptions } from "./bot";
import { withBotRequest } from "./bot-lifecycle";
import { createLLMBotToolRunner, llmBotTools } from "./llm-bot-tools";
import { selectConfiguredConversationModel } from "./model-resolution";
import { AGENT_ANSWER_ITEM_ID } from "./output-items";
import { readRuntimeLocaleSafe } from "./plan";
import { createAgentProjectInput, resolveAgentImageFiles } from "./project";
import { inheritConversationModelParams } from "./project-executor";
import { applyAgentProjectFixedValues } from "./project-params";
import { applyFolderAgentInput } from "../executor/folder-context";
import { readAgentSystemCredentials, selectAgentSystemLLM } from "./system-llm";
import type { AgentInput, AgentOutputPayload } from "./types";

const TURN = "steamharness.bot.llm:";
const NODE = "bot-llm-answer";
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_CALLS = 16;

export function createLLMBot<Input extends AgentInput>(
  options: Extract<BotDefinition<Input>, { engine: "llm" }>,
  params: BotParamDeclaration[],
  conversation: ConversationDefinition,
): BotExecutorDefinition<Input> {
  const llm = { ...options.llm };
  const tools = llmBotTools(options.tools);
  const inputContexts = new WeakMap<AgentInput, ExecutorContext>();
  const pending = new Map<string, Promise<AgentOutputPayload>>();
  const workflow = defineProject<AgentInput, AgentOutputPayload>({
    name: options.name ?? "bot",
    async run(input, context) {
      const host = readOpenAIConversationHostInput({ hostInput: input.hostInput });
      const requestId = host?.requestId ?? input.requestId ?? String(context.metadata?.runId ?? randomUUID());
      const key = JSON.stringify([context.projectId, context.entryId, context.actor?.userId, context.conversation.conversationId, requestId]);
      const active = pending.get(key);
      if (active) {
        const output = await active;
        return replayBotOutput(output, input, context);
      }
      const run = withBotRequest(requestId, () => runTurn(requestId, input, context), context);
      pending.set(key, run);
      try { return await run; } finally { pending.delete(key); }
    },
  });
  const definition: BotExecutorDefinition<Input> = {
    projectType: "bot", workflow, params, conversation, tools,
    tokenUsage: { enabled: true, display: true },
    resolveParams: options.resolveParams,
    createInput(context) {
      const input = createAgentProjectInput(context, { params, modelSource: llm.modelSource, model: llm.model });
      const host = readOpenAIConversationHostInput(context);
      if (host) {
        const last = [...host.messages].reverse().find(message => message.role === "user");
        const parts = last ? readHostParts(last.content) : [];
        input.prompt = parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
        input.images = parts.filter(part => part.type === "image");
        input.hostInput = host;
      }
      inputContexts.set(input, context);
      return input;
    },
  };
  inheritConversationModelParams(definition, params, llm.modelSource);
  return definition;

  async function runTurn(requestId: string, input: AgentInput, context: NodeContext): Promise<AgentOutputPayload> {
    context.abortSignal?.throwIfAborted();
    const turnId = `${TURN}${requestId}`;
    const runId = context.metadata?.runId;
    const state = await context.conversation.getValue();
    const saved = state.messages.find(message => message.id === `${turnId}:assistant`);
    let output: AgentOutputPayload;
    let usages: LLMUsage[] = [];
    if (saved) {
      const recorded = saved.metadata?.usage as LLMUsage[] | LLMUsage | undefined;
      usages = Array.isArray(recorded) ? recorded : recorded ? [recorded] : [];
      output = makeOutput(state.messages.find(message => message.id === `${turnId}:user`)?.content ?? "",
        saved.metadata?.provider as string, saved.metadata?.model as string, [answer(saved.content, saved.metadata?.finishReason)],
        typeof saved.metadata?.toolCallCount === "number" ? saved.metadata.toolCallCount : 0);
      await replayBotOutput(output, input, context);
    } else {
      const resolved = await resolveAgentImageFiles(context.folderContext ? { ...input, workdir: context.folderContext.directory, allowedDirectories: undefined } : input, context, NODE);
      const executor = inputContexts.get(input);
      const prepared = options.prepareInput ? await options.prepareInput({ ...resolved, requestId }, {
        ...context, args: executor?.args ?? [], paramValues: executor?.paramValues ?? {},
      }) : resolved;
      if (!prepared || typeof prepared.prompt !== "string") throw new HarnessError({ type: "input_validation", message: "Bot prepareInput must return an input with a prompt." });
      context.abortSignal?.throwIfAborted();
      const finalInput = applyFolderAgentInput(applyAgentProjectFixedValues(prepared, params), context);
      const route = await resolveProvider(finalInput, llm, context.abortSignal);
      const provider = route.provider;
      if (!(provider instanceof PiAiLLMProvider)) throw new HarnessError({ type: "provider_call", message: "LLM Bots require a pi-ai provider." });
      const current = userMessage(finalInput.prompt, finalInput.images);
      const host = readOpenAIConversationHostInput({ hostInput: input.hostInput });
      const messages = host ? hostHistory(host, current) : [...completedHistory(state.messages), current];
      // The ordinary node input is reported even when private model diagnostics are off.
      const nodeInput = { errCode: finalInput.errCode, errMessage: finalInput.errMessage, prompt: finalInput.prompt, requestId,
        provider: finalInput.provider, model: finalInput.model, images: finalInput.images?.map(({ mimeType }) => ({ mimeType })) };
      let executed = 0;
      const node = createOutputNode<typeof nodeInput, AgentOutputPayload>({ name: NODE, metadata: { type: "llm-stream" },
        async *stream(_input, nodeContext) {
          yield { type: "output_item_start", item: answer("") };
          const runner = await createLLMBotToolRunner(tools, nodeContext, llm.createTools && (() => llm.createTools!(nodeContext, finalInput as Input)), finalInput.permissionPolicy);
          const system = [llm.systemPrompt, finalInput.systemPrompt, host?.instructions, runner.botFileGuidance].filter(Boolean).join("\n\n") || undefined;
          const round: LLMBotToolRound = { tools: runner.tools, transcript: [] };
          const callIds = new Set<string>();
          try {
            for (let index = 0; ; index++) {
              nodeContext.abortSignal?.throwIfAborted();
              const request: LLMChatInput = { messages, system,
                temperature: host?.settings.temperature ?? llm.temperature,
                maxOutputTokens: host?.settings.maxOutputTokens ?? llm.maxOutputTokens,
                topP: host?.settings.topP, maxRetries: 0, abortSignal: nodeContext.abortSignal };
              if (nodeContext.nodeHooks?.onLLMBotModelRequest) {
                observeLLMBotModelRequest(request, { provider: route.id, publish: snapshot => nodeContext.nodeHooks?.onLLMBotModelRequest?.(snapshot) });
              }
              let response;
              for await (const chunk of provider.streamTurn(request, round)) {
                if (chunk.type === "text-delta") yield { type: "output_item_delta", itemId: AGENT_ANSWER_ITEM_ID, delta: chunk.text };
                else response = chunk;
              }
              nodeContext.abortSignal?.throwIfAborted();
              if (!response) throw new HarnessError({ type: "provider_call", message: "LLM Bot did not receive a completed answer." });
              if (response.usage) usages.push(response.usage);
              if (response.finishReason !== "tool-calls") {
                yield { type: "output_item_delta", itemId: AGENT_ANSWER_ITEM_ID, delta: "", item: { metadata: answer("", response.finishReason).metadata } };
                yield { type: "output_item_end", itemId: AGENT_ANSWER_ITEM_ID };
                return;
              }
              const calls = response.message.content.filter(part => part.type === "toolCall");
              if (!round.tools.length || !calls.length) throw new HarnessError({ type: "provider_call", message: "LLM Bot received an unexpected tool call." });
              if (index >= MAX_TOOL_ROUNDS || callIds.size + calls.length > MAX_TOOL_CALLS) {
                throw new HarnessError({ type: "provider_call", message: "LLM Bot reached the tool call limit for this turn." });
              }
              for (const call of calls) {
                if (!call.id || callIds.has(call.id)) throw new HarnessError({ type: "provider_call", message: "LLM Bot received an invalid or duplicate tool call ID." });
                callIds.add(call.id);
              }
              round.transcript.push(response.message);
              for (const call of calls) {
                const { result, executed: ran } = await runner.execute(call);
                if (ran) executed++;
                round.transcript.push(result);
              }
            }
          } finally { try { await runner.close(); } catch { /* Keep the original turn result. */ } }
        },
        format(stream) { return makeOutput(finalInput.prompt, route.id, route.model, stream.items, executed); },
      });
      const result = await runStreamNode(node, nodeInput, context);
      output = result.output!;
      context.abortSignal?.throwIfAborted();
      const item = output.items.find(item => item.id === AGENT_ANSWER_ITEM_ID)!;
      await context.conversation.appendMessages([
        { id: `${turnId}:user`, role: "user", content: finalInput.prompt, metadata: { images: finalInput.images } },
        { id: `${turnId}:assistant`, role: "assistant", content: String(item.content),
          metadata: { usage: usages, runId, provider: route.id, model: route.model, finishReason: item.metadata?.finishReason, toolCallCount: executed } },
      ]);
    }
    // A replay in another run has no new usage. Retrying the original run upserts its receipt.
    const receipt = createHash("sha256").update(JSON.stringify([context.conversation.conversationId, requestId])).digest("hex");
    if (!saved || saved.metadata?.runId === runId) {
      for (const [index, usage] of usages.entries()) await context.tokenUsage.report({ recordId: `${TURN}${receipt}${index ? `:${index}` : ""}`,
        providerName: output.provider, modelId: output.model, nodeName: NODE, ...usage,
        cachedInputTokens: usage.inputTokenDetails.cacheReadTokens, cacheCreationTokens: usage.inputTokenDetails.cacheWriteTokens,
        reasoningTokens: usage.outputTokenDetails.reasoningTokens });
    }
    if (options.onCompleted && state.values[`${turnId}:notified`] !== true) {
      try {
        const returned = await options.onCompleted(deepFreezeBotOutput(structuredClone({ requestId, output })), context);
        if (returned !== undefined) throw new Error("Bot onCompleted must return void; output replacement is forbidden.");
        await context.conversation.setValue(`${turnId}:notified`, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new HarnessError({ type: "execution", message: `${readRuntimeLocaleSafe() === "zh-CN" ? "Bot 答复已完成，但完成通知失败" : "Bot answer completed; completion notification failed"}: ${message}`,
          metadata: { phase: "bot_completion", requestId } });
      }
    }
    return output;
  }
}

async function resolveProvider(input: AgentInput, options: Pick<BotLLMOptions, "model" | "modelSource">, signal?: AbortSignal): Promise<{ provider: LLMProvider; id: string; model: string }> {
  const selection = await selectConfiguredConversationModel(input.model ?? options.model, options.modelSource, signal);
  if (selection?.source === "third-party") {
    const { id, model, apiKind, baseUrl, apiKey } = selection.selected;
    const type = apiKind === "anthropic-messages" ? "anthropic" : apiKind === "openai-responses" ? apiKind : "openai-completion";
    return { id, model, provider: createLLMProvider({ type, baseURL: baseUrl, apiKey, model }) };
  }
  const { credential, model } = selection ? { credential: selection.credential, model: selection.selected.model } :
    selectAgentSystemLLM(await readAgentSystemCredentials(signal), { provider: input.provider, model: input.model ?? options.model });
  return { provider: credential.createProvider({ model }), id: credential.id, model };
}

function completedHistory(messages: ConversationMessageContract[]): LLMMessage[] {
  const turns = new Set(messages.filter(message => message.id.startsWith(TURN) && message.id.endsWith(":assistant") && message.role === "assistant")
    .map(message => message.id.slice(0, -":assistant".length)));
  return messages.flatMap((message): LLMMessage[] => {
    if (message.role === "user" && message.id.endsWith(":user") && turns.has(message.id.slice(0, -":user".length))) {
      return [userMessage(message.content, message.metadata?.images as AgentInput["images"])];
    }
    if (message.role === "assistant" && message.id.endsWith(":assistant") && turns.has(message.id.slice(0, -":assistant".length))) {
      return [{ role: "assistant", content: message.content }];
    }
    return [];
  });
}

function hostHistory(host: OpenAIConversationHostInput, current: LLMMessage): LLMMessage[] {
  const last = host.messages.map(message => message.role).lastIndexOf("user");
  const history = host.messages.flatMap((message, index): LLMMessage[] => {
    if (index === last) return [current];
    if (message.status === "incomplete" || message.status === "in_progress") return [];
    const parts = readHostParts(message.content);
    if (message.role === "user") return [{ role: "user", content: parts }];
    return [{ role: message.role === "assistant" ? "assistant" : "system", content: parts.filter(part => part.type === "text") }];
  });
  return last === -1 ? [...history, current] : history;
}

function readHostParts(parts: OpenAIConversationHostInput["messages"][number]["content"]) {
  return parts.map(part => {
    if (part.type !== "input_image") return { type: "text" as const, text: part.text };
    const match = /^data:([^;,]+);base64,(.*)$/su.exec(part.image_url);
    if (!match) throw new HarnessError({ type: "input_validation", message: "Bot image input must be an inline data URL." });
    return { type: "image" as const, mimeType: match[1]!, data: match[2]! };
  });
}

function userMessage(prompt: string, images: AgentInput["images"]): LLMMessage {
  return { role: "user", content: images?.length ? [{ type: "text", text: prompt },
    ...images.map((image): LLMImagePart => ({ type: "image", ...image }))] : prompt };
}

function answer(content: string, finishReason?: unknown): OutputItem {
  return { id: AGENT_ANSWER_ITEM_ID, title: readRuntimeLocaleSafe() === "zh-CN" ? "答复" : "Answer", content,
    contentType: "markdown", metadata: { kind: "agent-answer", ...(finishReason === undefined ? {} : { finishReason }) } };
}

function makeOutput(prompt: string, provider: string, model: string, items: OutputItem[], toolCallCount: number): AgentOutputPayload {
  return { ...createOutputPayload({ items }), prompt, provider, model, workdir: "", effort: "off", agent: "build", toolCallCount };
}
