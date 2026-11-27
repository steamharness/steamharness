import { readRuntimeLocaleSafe } from "./plan";
import { agentSessionLease } from "./session-control";
import { currentBotRequestId, withBotRequest } from "./bot-lifecycle";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from 'node:path';
import { localProjectDirectory, localRuntimeAccountDirectory, prepareLocalDirectory } from '@steamharness/project-manifest/node';
import type { NodeContext } from "../types/index";
import type { BotExecutorDefinition, ConversationDefinition, BotParamDeclaration, ExecutorContext, ParamResolveResult, ParamResolverContext } from "../executor/types";
import type { AgentInput, AgentOutputPayload, AgentProjectOptions, AgentToolSet } from "./types";
import type { AgentSessionOptions, AgentSessionSnapshot } from "./session-types";
import { normalizeToolPermissionDefinitions, type ToolPermissionDefinition } from "../tool-permissions/index";
import { createCoreBotProject, createAgentProjectInput, resolveAgentImageFiles } from "./project";
import { applyAgentProjectFixedValues, createAgentProjectParams, fixedAgentModel, registerAgentProject } from "./project-params";
import { inheritAgentProjectParams } from "./project-executor";
import { assertProjectParamDeclarations, normalizeProjectParamDeclarations } from "../executor/param-definition";
import { assertConversationCommands } from "../executor/conversation-commands";
import { assertConversationFooter } from "../executor/conversation-footer";
import { assertConversationUserInput } from "../executor/conversation-input";
import { assertConversationPresentation } from "../executor/conversation-presentation";
import { readOpenAIConversationHostInput } from "../executor/openai";
import { readAgentToolDefinitions } from "./permission";
import { defineProject, runStreamNode } from "../workflow/index";
import { createOutputNode, createOutputPayload } from "../node/output/index";
import { HarnessError } from "../workflow/errors";
import { AGENT_ANSWER_ITEM_ID } from "./output-items";
import { botMemoryDefault, type BotMemoryOptions } from "./memory-configuration";
import { BOT_MEMORY_TOOL_DEFINITIONS } from "./memory";
import { BOT_FILE_TOOL_DEFINITIONS, BOT_FILE_TOOL_NAMES } from "./bot-files";
import { BOT_ARTIFACT_TOOL } from "./bot-artifact";
import { BOT_CREDENTIAL_TOOL, BOT_CREDENTIAL_USE_TOOL } from "./bot-credential";
import { BOT_JSON_SUMMARY_DEFINITION } from "./bot-json-summary";
import { createLLMBot } from "./llm-bot";
import { applyFolderAgentInput } from "../executor/folder-context";

/** A library caller's cwd is not a Bot workspace. */
function withBotWorkdir<T extends AgentInput>(input: T, context: NodeContext, fallback?: string): T {
  const selected = context.folderContext?.directory || input.workdir?.trim() || fallback?.trim();
  if (selected && path.isAbsolute(selected)) {
    const workdir = path.resolve(selected);
    return input.workdir === workdir ? input : { ...input, workdir };
  }
  const host = context.metadata?.executionWorkdir;
  const base = typeof host === 'string' && path.isAbsolute(host) ? host
    : prepareLocalDirectory(localProjectDirectory(localRuntimeAccountDirectory(), context.projectId));
  return { ...input, workdir: path.resolve(base, selected || '.') };
}

export interface BotInputContext extends NodeContext {
  readonly args: string[];
  readonly paramValues: ExecutorContext["paramValues"];
}
export type BotAgentOptions<Input extends AgentInput = AgentInput> = Omit<AgentProjectOptions,
  "outputItemId" | "executorName" | "projectName" | "params" | "collapseIntermediate" | "toolDefinitions" | "createTools" | "createSession"> & {
  createTools?(context: NodeContext, input: Readonly<Input>): AgentToolSet | AgentToolSet["tools"] | Promise<AgentToolSet | AgentToolSet["tools"]>;
  createSession?(context: NodeContext, input: Readonly<Input>): AgentSessionOptions | Promise<AgentSessionOptions>;
};
type Immutable<T> = T extends readonly (infer Item)[] ? readonly Immutable<Item>[]
  : T extends object ? { readonly [Key in keyof T]: Immutable<T[Key]> } : T;

export interface BotCompletion {
  readonly requestId: string;
  readonly output: Immutable<AgentOutputPayload>;
}
export type BotConversationOptions = Omit<ConversationDefinition, "engine" | "durable" | "inputQueue" | "openai" | "recovery"> & {
  recovery?: { startup?: "automatic" | "manual" };
};
export type BotEngine = "agent" | "llm";
export interface BotLLMOptions<Input extends AgentInput = AgentInput> {
  systemPrompt?: string;
  modelSource?: "user-settings" | "project";
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  createTools?(context: NodeContext, input: Readonly<Input>): AgentToolSet | AgentToolSet["tools"] | Promise<AgentToolSet | AgentToolSet["tools"]>;
}
interface BotHooks<Input extends AgentInput> {
  name?: string;
  tools?: ToolPermissionDefinition[];
  params?: BotParamDeclaration[];
  resolveParams?(context: ParamResolverContext): ParamResolveResult | Promise<ParamResolveResult>;
  conversation?: BotConversationOptions;
  prepareInput?(input: AgentInput, context: BotInputContext): Input | Promise<Input>;
  onCompleted?(result: BotCompletion, context: NodeContext): void | Promise<void>;
}
export type BotDefinition<Input extends AgentInput = AgentInput> = BotHooks<Input> & (
  | { engine: "agent"; agent?: BotAgentOptions<Input>; llm?: never; memory?: BotMemoryOptions }
  | { engine: "llm"; llm: BotLLMOptions<Input>; agent?: never; memory?: never }
);

const definitions = new WeakSet<object>();
export function isDefinedBot(value: object): boolean { return definitions.has(value); }

/** Shared by the source inspector and runtime. */
export function botConversationDefaults(engine: BotEngine, options: BotConversationOptions = {}): ConversationDefinition {
  if (!options || typeof options !== "object" || Array.isArray(options)) invalid("Bot conversation settings must be an object.");
  assertConversationPresentation(options.collapseIntermediate);
  if (options.recovery?.startup !== undefined && !["automatic", "manual"].includes(options.recovery.startup)) invalid("Bot recovery.startup must be automatic or manual.");
  for (const key of ["engine", "durable", "inputQueue", "openai", "defaultInput", "enabled"]) {
    if (Object.hasOwn(options, key)) invalid(`Bot conversation.${key} is owned by Core.`);
  }
  if (options.recovery && Object.hasOwn(options.recovery, "enabled")) invalid("Bot recovery is always enabled.");
  const { recovery, ...presentation } = options;
  if (engine === "llm" && (recovery !== undefined || options.attachments?.files || options.attachments?.videos)) {
    invalid("LLM Bots do not support automatic recovery, file or video attachments.");
  }
  return { engine, attachments: { images: true }, ...presentation, collapseIntermediate: options.collapseIntermediate ?? true,
    ...(engine === "agent" ? { recovery: { enabled: true, startup: recovery?.startup ?? "automatic" }, durable: { enabled: true } } as const : {}),
    inputQueue: { enabled: true }, openai: { enabled: true, outputItemId: AGENT_ANSWER_ITEM_ID } };
}
export function botParams(engine: BotEngine, modelOptions: Pick<AgentProjectOptions, "paramOptions" | "modelSource" | "model" | "effort" | "permissionPolicy" | "mode"> = {}, extra: BotParamDeclaration[] = []): BotParamDeclaration[] {
  const builtins = createAgentProjectParams(modelOptions).filter(field => engine === "agent" || field.kind === "quick" && field.id === "model");
  const reserved = new Set(["provider", "model", "effort", "plan", "permissionPolicy"]);
  for (const field of normalizeProjectParamDeclarations(extra).params) {
    if (reserved.has(field.name)) invalid(engine === "agent" ? `Bot parameter "${field.name}" must be customized through agent.paramOptions.` : `Bot parameter "${field.name}" is reserved.`);
  }
  const result = [...builtins, ...extra];
  assertProjectParamDeclarations(result, "bot");
  return result;
}

export function assertBotLLMOptions(value: unknown): asserts value is BotLLMOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Bot llm settings must be an object.");
  const llm = value as Record<string, unknown>;
  for (const key of Object.keys(llm)) {
    if (!["systemPrompt", "modelSource", "model", "temperature", "maxOutputTokens", "createTools"].includes(key)) invalid(`Unsupported Bot llm field "${key}".`);
  }
  if (llm.createTools !== undefined && typeof llm.createTools !== "function") invalid("Bot llm.createTools must be a function.");
  if (llm.modelSource !== undefined && llm.modelSource !== "user-settings" && llm.modelSource !== "project") invalid("Bot llm.modelSource must be user-settings or project.");
  if (llm.systemPrompt !== undefined && typeof llm.systemPrompt !== "string") invalid("Bot llm.systemPrompt must be a string.");
  if (llm.model !== undefined && (typeof llm.model !== "string" || !llm.model.trim())) invalid("Bot llm.model must be a non-empty string.");
  if (llm.temperature !== undefined && (typeof llm.temperature !== "number" || !Number.isFinite(llm.temperature) || llm.temperature < 0)) invalid("Bot llm.temperature must be a non-negative number.");
  if (llm.maxOutputTokens !== undefined && (typeof llm.maxOutputTokens !== "number" || !Number.isSafeInteger(llm.maxOutputTokens) || llm.maxOutputTokens <= 0)) invalid("Bot llm.maxOutputTokens must be a positive integer.");
}
export function botTools(agent: Pick<AgentProjectOptions, "tools" | "session" | "skills"> & { createSession?: unknown } = {}, overrides: ToolPermissionDefinition[] = []): ToolPermissionDefinition[] {
  normalizeToolPermissionDefinitions(overrides);
  const defaults = [...readAgentToolDefinitions(agent.tools), ...BOT_MEMORY_TOOL_DEFINITIONS, ...BOT_FILE_TOOL_DEFINITIONS, BOT_ARTIFACT_TOOL, BOT_JSON_SUMMARY_DEFINITION, BOT_CREDENTIAL_TOOL, BOT_CREDENTIAL_USE_TOOL,
    { name: "update_plan", label: "Task plan", enabled: true, autoApprove: true },
    ...(agent.session?.subagents || agent.createSession ? [{ name: "subagent", label: "Delegate task", enabled: true, autoApprove: true }] : []),
    ...(agent.skills ? [{ name: "skill", label: "Skills", enabled: true, autoApprove: true }] : []),
    ...(agent.session?.toolSearch ? [{ name: "tool_search", label: "Find tools", enabled: true, autoApprove: true }] : []),
    ...(agent.session?.codeMode ? [{ name: "codemode", label: "Code Mode", enabled: true, autoApprove: true }] : [])];
  const configured = overrides.map(tool => (BOT_FILE_TOOL_NAMES.includes(tool.name) || tool.name === BOT_ARTIFACT_TOOL.name || tool.name === BOT_JSON_SUMMARY_DEFINITION.name)
    ? { ...tool, approvalMode: tool.approvalMode ?? "always" as const } : tool);
  return [...new Map([...defaults, ...configured].map(tool => [tool.name, tool])).values()];
}

/** A project supplies policy and hooks; only Core supplies its executable workflow. */
export function defineBot<Input extends AgentInput = AgentInput>(options: BotDefinition<Input>): BotExecutorDefinition<Input> {
  if (!options || typeof options !== "object" || Array.isArray(options)) invalid("defineBot requires a configuration object.");
  const allowed = new Set(["engine", "name", "memory", "agent", "llm", "tools", "params", "resolveParams", "conversation", "prepareInput", "onCompleted"]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) invalid(`Unsupported Bot field "${key}". Use defineBot configuration and hooks.`);
  if (options.engine !== "agent" && options.engine !== "llm") invalid('defineBot requires engine: "agent" or "llm".');
  if (options.engine === "llm") {
    for (const key of ["agent", "memory"]) if (Object.hasOwn(options, key)) invalid(`Bot ${key} requires engine: "agent".`);
    assertBotLLMOptions(options.llm);
    const conversation = botConversationDefaults("llm", options.conversation);
    const params = botParams("llm", options.llm, options.params);
    assertBotPresentation(conversation, params);
    const definition = createLLMBot(options, params, conversation);
    definitions.add(definition);
    Object.freeze(definition.workflow);
    return Object.freeze(definition);
  }
  if (Object.hasOwn(options, "llm")) invalid('Bot llm requires engine: "llm".');
  if (options.agent === null) invalid("Bot agent settings must be an object.");
  const agent = options.agent ?? {};
  if (typeof agent !== "object" || Array.isArray(agent)) invalid("Bot agent settings must be an object.");
  for (const key of ["outputItemId", "executorName", "projectName", "params", "collapseIntermediate", "toolDefinitions"]) {
    if (Object.hasOwn(agent, key)) invalid(`Bot agent.${key} is not customizable.`);
  }
  const params = botParams("agent", agent, options.params);
  const lockedModel = fixedAgentModel(params);
  const memoryDefaultEnabled = botMemoryDefault(options.memory);
  const conversation = botConversationDefaults("agent", options.conversation);
  assertBotPresentation(conversation, params);
  const current = new AsyncLocalStorage<Input>();
  const inputContexts = new WeakMap<object, ExecutorContext>();
  const ownerContexts = new Map<string, ExecutorContext>();
  const attemptedCompletions = new Set<string>();
  const pendingCompletions = new Map<string, Promise<void>>();
  const completionStates = new Map<string, CompletionState>();
  const ownerKey = (context: NodeContext) => JSON.stringify([context.projectId, context.entryId, context.actor?.userId, context.conversation.conversationId]);
  const completionKey = (requestId: string, context: NodeContext) => `steamharness.bot.completion:${JSON.stringify([context.projectId, context.entryId, context.actor?.userId, context.conversation.conversationId, requestId])}`;
  async function prepare(input: AgentInput, context: NodeContext, reuse = false): Promise<Input> {
    const requestId = input.requestId ?? String(context.metadata?.runId ?? randomUUID());
    const key = `steamharness.bot.input:${requestId}`;
    const persist = !!options.prepareInput && input.hostInput === undefined;
    const saved = persist ? (await context.conversation.getValue()).values[key] as Input | undefined : undefined;
    if (saved && reuse) return applyFolderAgentInput(withBotWorkdir(applyAgentProjectFixedValues(saved, params) as Input, context, input.workdir ?? agent.workdir), context, lockedModel);
    const executor = inputContexts.get(input) ?? ownerContexts.get(ownerKey(context));
    const scoped = withBotWorkdir(input, context, agent.workdir);
    const parsed = await resolveAgentImageFiles(context.folderContext ? { ...scoped, allowedDirectories: undefined } : scoped, context, `${options.name ?? "bot"}-input`);
    const prepared = options.prepareInput ? await withBotRequest(requestId, () => options.prepareInput!(parsed, {
      ...context, args: executor?.args ?? [], paramValues: executor?.paramValues ?? {} }), context) : parsed;
    if (!prepared || typeof prepared.prompt !== "string") invalid("Bot prepareInput must return an AgentInput with a prompt.");
    context.abortSignal?.throwIfAborted();
    const result = applyFolderAgentInput(withBotWorkdir({ ...applyAgentProjectFixedValues(prepared, params), requestId } as Input, context, parsed.workdir), context, lockedModel);
    if (persist) await context.conversation.setValue(key, result);
    return result;
  }
  async function complete(requestId: string, output: AgentOutputPayload, context: NodeContext, retry = false): Promise<void> {
    if (!options.onCompleted || output.errCode !== 0) return;
    const key = completionKey(requestId, context);
    const active = pendingCompletions.get(key);
    if (active) return active;
    if (!retry && attemptedCompletions.has(key)) return;
    const pending = (async () => {
      const saved = completionStates.get(key) ?? (await context.conversation.getValue()).values[key] as CompletionState | undefined;
      if (saved) completionStates.set(key, saved);
      if (saved?.notified) return;
      attemptedCompletions.add(key);
      const original = saved?.output ?? output;
      await context.conversation.setValue(key, { output: original, notified: false } satisfies CompletionState);
      try {
        const returned = await withBotRequest(requestId, () => options.onCompleted!(deepFreezeBotOutput(structuredClone({ requestId, output: original })), context), context);
        if (returned !== undefined) invalid("Bot onCompleted must return void; output replacement is forbidden.");
        const done = { notified: true } satisfies CompletionState;
        await context.conversation.setValue(key, done); completionStates.set(key, done);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = { output: original, notified: false, error: message } satisfies CompletionState;
        await context.conversation.setValue(key, failure); completionStates.set(key, failure);
        throw new HarnessError({ type: "execution", message: `${readRuntimeLocaleSafe() === "zh-CN" ? "Bot 答复已完成，但完成通知失败" : "Bot answer completed; completion notification failed"}: ${message}`,
          metadata: { phase: "bot_completion", requestId, agentCompleted: true } });
      }
    })();
    pendingCompletions.set(key, pending);
    try { await pending; } finally { pendingCompletions.delete(key); }
  }
  async function completed(snapshot: AgentSessionSnapshot, input: AgentInput, context: NodeContext): Promise<void> {
    if (!options.onCompleted) return;
    for (const turn of snapshot.turns) {
      if (turn.conversationId !== snapshot.conversationId || turn.status !== "done" || turn.mode === "report" || turn.mode === "steer" || turn.hiddenInput) continue;
      const requestId = input.requestId && turn.requestId.startsWith(`${input.requestId}:plan:`) ? input.requestId : turn.requestId;
      if (completionStates.get(completionKey(requestId, context))?.notified) continue;
      const items = turn.items.map((item, index) => ({ ...item, id: item.id ?? `bot-part-${index}` }));
      const last = [...items].reverse().find(item => (item.contentType === "text" || item.contentType === "markdown") &&
        (!item.metadata || item.metadata.kind === "agent-answer" || item.metadata.kind === "agent-part" && item.metadata.partType === "text" || item.metadata.plan === true));
      if (last) last.id = AGENT_ANSWER_ITEM_ID;
      const output: AgentOutputPayload = { ...createOutputPayload({ items }), prompt: turn.prompt, workdir: input.workdir ?? "",
        provider: snapshot.configuration.provider, model: snapshot.configuration.model,
        effort: snapshot.configuration.effort as AgentOutputPayload["effort"], agent: input.agent ?? "build",
        toolCallCount: items.filter(item => item.metadata?.partType === "tool").length };
      try { await complete(requestId, output, context); }
      catch { /* The persisted notification error is projected alongside this successful turn. */ }
      const notification = completionStates.get(completionKey(requestId, context));
      if (notification?.error && !notification.notified) turn.items.push({
        id: `bot-completion:${requestId}`, title: readRuntimeLocaleSafe() === "zh-CN" ? "Bot 完成通知" : "Bot completion notification", contentType: "text",
        content: notification.error, collapsed: false, metadata: { kind: "agent-notice", status: "failed", phase: "bot_completion" },
      });
    }
  }
  const { createTools, createSession, ...agentOptions } = agent;
  const coreOptions: AgentProjectOptions = { ...agentOptions, params, executorName: options.name ?? "bot", outputItemId: AGENT_ANSWER_ITEM_ID,
    session: agent.session ?? {},
    ...(agent.createTools ? { async createTools(context: NodeContext) {
      const initial = current.getStore()!;
      const created = await agent.createTools!(context, initial);
      const set = Array.isArray(created) ? { tools: created } : created;
      return { ...set, tools: set.tools.map(tool => ({ ...tool, async execute(...args: Parameters<typeof tool.execute>) {
        const requestId = currentBotRequestId();
        if (!requestId || requestId === initial.requestId) return tool.execute(...args);
        const prepared = (await context.conversation.getValue()).values[`steamharness.bot.input:${requestId}`] as Input | undefined;
        if (!prepared) return tool.execute(...args);
        const refreshed = await agent.createTools!(context, prepared);
        const next = Array.isArray(refreshed) ? { tools: refreshed } : refreshed;
        try {
          const selected = next.tools.find(candidate => candidate.name === tool.name);
          if (!selected) throw new HarnessError({ type: "tool_permission_denied", message: `Tool "${tool.name}" is unavailable for this Bot input.` });
          return await selected.execute(...args);
        } finally { await next.close?.(); }
      } })) };
    } } : {}),
    ...(agent.createSession ? { createSession: context => agent.createSession!(context, current.getStore()!) } : {}) };
  const core = createCoreBotProject(coreOptions, { memoryDefaultEnabled, prepare: (input, context) => prepare(input, context, true), completed });
  const workflow = registerAgentProject(defineProject<Input, AgentOutputPayload>({
    name: options.name ?? "bot",
    async run(input, context) {
      const requestId = input.requestId ?? String(context.metadata?.runId ?? randomUUID());
      const executor = inputContexts.get(input);
      if (executor) ownerContexts.set(ownerKey(context), executor);
      const previous = options.onCompleted ? (await context.conversation.getValue()).values[completionKey(requestId, context)] as CompletionState | undefined : undefined;
      let output: AgentOutputPayload;
      if (previous?.output && !agentSessionLease(context.conversation.conversationId ?? "")) {
        output = await replayBotOutput(previous.output, input, context);
      } else {
        const finalInput = await prepare({ ...input, requestId }, context);
        output = await withBotRequest(requestId, () => current.run(finalInput, () => core.run(finalInput, context)), context);
      }
      await complete(requestId, output, context, true);
      return output;
    },
  }), coreOptions);
  const definition: BotExecutorDefinition<Input> = {
    projectType: "bot", workflow: workflow as BotExecutorDefinition<Input>["workflow"], params, conversation,
    tokenUsage: { enabled: true, display: true }, tools: botTools(agent, options.tools),
    ...(options.resolveParams ? { resolveParams: options.resolveParams } : {}),
    createInput(context) {
      const input = createAgentProjectInput(context, coreOptions);
      const host = readOpenAIConversationHostInput(context);
      if (host) {
        const message = [...host.messages].reverse().find(message => message.role === "user");
        input.prompt = message?.content.filter(part => part.type === "input_text").map(part => part.text).join("\n") ?? "";
        input.images = host.messages.flatMap(message => message.content).flatMap(part => {
          if (part.type !== "input_image") return [];
          const match = /^data:([^;,]+);base64,(.*)$/su.exec(part.image_url);
          if (!match) invalid("Bot image input must be an inline data URL.");
          return [{ mimeType: match[1]!, data: match[2]! }];
        });
        input.hostInput = host;
      }
      inputContexts.set(input, context);
      return input as Input;
    },
  };
  inheritAgentProjectParams(definition);
  definitions.add(definition);
  Object.freeze(workflow);
  return Object.freeze(definition);
}

function assertBotPresentation(conversation: ConversationDefinition, params: BotParamDeclaration[]) {
  const fields = normalizeProjectParamDeclarations(params).params;
  assertConversationCommands(conversation.commands, fields);
  assertConversationFooter(conversation.footer, fields);
  assertConversationUserInput(conversation.userInput, fields);
}

interface CompletionState { output?: AgentOutputPayload; notified: boolean; error?: string }
export async function replayBotOutput(output: AgentOutputPayload, input: AgentInput, context: NodeContext): Promise<AgentOutputPayload> {
  const node = createOutputNode<AgentInput, AgentOutputPayload>({ name: "bot-completed-output",
    async *stream() { for (const item of output.items) yield { type: "output_item_start" as const, item }; },
    format() { return structuredClone(output); } });
  return (await runStreamNode(node, input, context)).output!;
}
export function deepFreezeBotOutput<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreezeBotOutput(child); Object.freeze(value); }
  return value;
}
function invalid(message: string): never { throw new HarnessError({ type: "input_validation", message }); }
