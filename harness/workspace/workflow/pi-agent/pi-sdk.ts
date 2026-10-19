import type {
  PiAgentParsedInput,
  PiAgentProvider,
  PiAgentSessionEvent,
  PiAgentSessionFactory,
  PiAgentSessionRunner,
  PiAgentSessionSnapshot,
  PiAgentToolEvent,
  PiAgentUsage,
} from "./interface";
import { createKnowledgeDocumentsTool, KNOWLEDGE_DOCUMENTS_TOOL_NAME } from "./knowledge-documents-tool";
import { createToolApprovalDecisionChunks } from "./output-items";

type ExtensionFactory = (pi: {
  on(
    event: "tool_call",
    handler: (event: { toolName: string; input: Record<string, unknown> }) => Promise<{ block?: boolean; reason?: string } | undefined>,
  ): void;
}) => void | Promise<void>;

interface PiCodingAgentModule {
  AuthStorage: {
    inMemory(): {
      setRuntimeApiKey(provider: string, apiKey: string): void;
    };
  };
  getAgentDir(): string;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiLiveSession }>;
  ModelRegistry: {
    inMemory(authStorage: unknown): PiModelRegistry;
  };
  DefaultResourceLoader: new (options: {
    cwd: string;
    agentDir: string;
    settingsManager?: unknown;
    extensionFactories?: ExtensionFactory[];
  }) => {
    reload(): Promise<void>;
  };
  SessionManager: {
    inMemory(): unknown;
  };
  SettingsManager: {
    create(cwd: string, agentDir?: string): unknown;
  };
}

interface PiModelRegistry {
  find(provider: string, modelId: string): unknown | undefined;
  registerProvider(provider: string, config: Record<string, unknown>): void;
}

interface PiLiveSession extends PiAgentSessionSnapshotSource {
  subscribe(listener: (event: PiAgentSdkEvent) => void): () => void;
  prompt(prompt: string, options: Record<string, unknown>): Promise<unknown>;
  dispose(): void;
}

type PiAgentSdkEvent =
  | {
    type: "message_update";
    assistantMessageEvent?: unknown;
  }
  | {
    type: "tool_execution_start";
    toolCallId: string;
    toolName: string;
    args?: unknown;
  }
  | {
    type: "tool_execution_update";
    toolCallId: string;
    toolName: string;
    args?: unknown;
    partialResult?: unknown;
  }
  | {
    type: "tool_execution_end";
    toolCallId: string;
    toolName: string;
    result?: unknown;
    isError?: boolean;
  }
  | {
    type: string;
    [key: string]: unknown;
  };

export interface PiAgentRuntimeOptions {
  getEnv(name: string): string | undefined;
  context?: unknown;
  onPendingApproval?: (error: workflow.HarnessError) => void;
}

interface ToolApprovalContext {
  toolPermissions?: {
    getTool(name: string): { enabled: boolean; autoApprove: boolean; label?: string; description?: string } | undefined;
  };
}

type PiAgentEventSink = (event: PiAgentSessionEvent) => void;

export interface PiAgentSessionSnapshotSource {
  sessionId?: string;
  messages?: unknown[];
  getActiveToolNames?: () => string[];
  getSessionStats?: () => { tokens?: Record<string, unknown> };
  getStats?: () => { tokens?: Record<string, unknown> };
}

export function createPiAgentSessionFactory(options: PiAgentRuntimeOptions): PiAgentSessionFactory {
  return async (input, hooks) => {
    if (input.dryRun) {
      return createDryRunPiAgentSession(input);
    }

    return createLivePiAgentSession(input, {
      ...options,
      onPendingApproval: hooks?.onPendingApproval ?? options.onPendingApproval,
    });
  };
}

function createDryRunPiAgentSession(input: PiAgentParsedInput): PiAgentSessionRunner {
  const text = [
    `Pi dry-run session for ${input.workdir}.`,
    `Provider: ${input.provider}`,
    `Prompt: ${input.prompt}`,
    input.model ? `Model: ${input.model}` : "Model: default",
    input.baseUrl ? `Base URL: ${input.baseUrl}` : "Base URL: default",
    input.tools.length > 0 ? `Tools: ${input.tools.join(", ")}` : "Tools: default",
  ].join("\n");

  return {
    async *prompt() {
      const words = text.split(/(\s+)/).filter((part) => part.length > 0);
      for (const word of words) {
        yield { type: "text_delta", delta: word } satisfies PiAgentSessionEvent;
      }
    },
    getSnapshot() {
      return {
        sessionId: "pi-agent-dry-run",
        messages: [
          { role: "user", content: input.prompt },
          { role: "assistant", content: text },
        ],
        activeTools: input.tools,
        usage: {
          inputTokens: 12,
          outputTokens: 24,
          cacheReadTokens: 4,
          cacheWriteTokens: 6,
          totalTokens: 46,
        },
      };
    },
    dispose() {},
  };
}

async function createLivePiAgentSession(
  input: PiAgentParsedInput,
  options: PiAgentRuntimeOptions,
): Promise<PiAgentSessionRunner> {
  const piSdk = await import("@earendil-works/pi-coding-agent") as PiCodingAgentModule;
  const authStorage = piSdk.AuthStorage.inMemory();
  const apiKey = readProviderApiKey(input.provider, options);
  if (apiKey !== undefined) {
    authStorage.setRuntimeApiKey(input.provider, apiKey);
  }
  const modelRegistry = piSdk.ModelRegistry.inMemory(authStorage);
  registerProviderRuntimeConfig(modelRegistry, input, apiKey);
  const model = input.model ? modelRegistry.find(input.provider, input.model) : undefined;
  const agentDir = piSdk.getAgentDir();
  const queue: PiAgentSessionEvent[] = [];
  const delayedKnowledgeToolEvents = __test_createDelayedToolEventBuffer(
    KNOWLEDGE_DOCUMENTS_TOOL_NAME,
    shouldDelayToolEventsUntilApproval(options.context, KNOWLEDGE_DOCUMENTS_TOOL_NAME),
  );
  let pendingResolve: (() => void) | undefined;
  let done = false;
  let error: unknown;
  const resourceLoader = new piSdk.DefaultResourceLoader({
    cwd: input.workdir,
    agentDir,
    settingsManager: piSdk.SettingsManager.create(input.workdir, agentDir),
    extensionFactories: options.context === undefined
      ? []
      : [createWorkflowToolPermissionExtension(options.context, (event) => {
          queue.push(event);
          pendingResolve?.();
          pendingResolve = undefined;
        })],
  });
  await resourceLoader.reload();

  // keeps the Pi SDK dependency behind this adapter so workspace tests
  // can inject a dry-run session while live runs use Pi's public SDK surface.
  const { session } = await piSdk.createAgentSession({
    cwd: input.workdir,
    sessionManager: piSdk.SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    resourceLoader,
    ...(model !== undefined ? { model } : {}),
    ...(input.explicitTools ? { tools: input.tools } : {}),
    ...(input.knowledgeTools && input.tools.includes(KNOWLEDGE_DOCUMENTS_TOOL_NAME) && options.context !== undefined
      ? {
          customTools: [createKnowledgeDocumentsTool({
            context: options.context,
            emit(event) {
              queue.push(event);
              if (isToolApprovalDecisionEnd(event)) {
                delayedKnowledgeToolEvents.releaseTo(queue);
              }
              pendingResolve?.();
              pendingResolve = undefined;
            },
            onPendingApproval(approvalError) {
              options.onPendingApproval?.(approvalError);
              // Pi custom tool implementations can convert a thrown
              // workflow pause into a tool-level error. Wake the stream here so
              // the workflow runtime records waiting_for_input immediately.
              error = approvalError;
              done = true;
              pendingResolve?.();
              pendingResolve = undefined;
            },
          })],
        }
      : {}),
  });

  const unsubscribe = session.subscribe((event) => {
    try {
      for (const normalized of normalizePiAgentEvent(event)) {
        if (!delayedKnowledgeToolEvents.push(normalized)) {
          queue.push(normalized);
        }
      }
    } catch (caught) {
      error = caught;
    } finally {
      pendingResolve?.();
      pendingResolve = undefined;
    }
  });

  return {
    async *prompt(prompt) {
      const promptPromise = session.prompt(prompt, { source: "extension" })
        .catch((caught) => {
          error = caught;
        })
        .finally(() => {
          done = true;
          if (!isPendingToolApprovalError(error)) {
            delayedKnowledgeToolEvents.releaseTo(queue);
          }
          pendingResolve?.();
          pendingResolve = undefined;
        });

      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            pendingResolve = resolve;
          });
          continue;
        }
        const event = queue.shift();
        if (event !== undefined) {
          yield event;
        }
      }

      if (isPendingToolApprovalError(error)) {
        throw error;
      }
      await promptPromise;
      if (error !== undefined) {
        throw error;
      }
    },
    getSnapshot() {
      return createPiAgentSessionSnapshot(session);
    },
    dispose() {
      unsubscribe();
      session.dispose();
    },
  };
}

export function __test_createDelayedToolEventBuffer(toolName: string, enabled: boolean) {
  let released = false;
  const delayed: PiAgentSessionEvent[] = [];

  return {
    push(event: PiAgentSessionEvent): boolean {
      if (!enabled || released || !isToolEventFor(event, toolName)) {
        return false;
      }
      // Pi SDK emits custom tool lifecycle events before the tool's
      // internal approval gate has a chance to publish the approval decision.
      // Hold those lifecycle rows until approval is visible, so final output
      // order remains "approval -> tool -> answer" instead of appearing to run
      // the tool before the user approved it.
      delayed.push(event);
      return true;
    },
    releaseTo(queue: PiAgentSessionEvent[]): void {
      if (released) {
        return;
      }
      released = true;
      queue.push(...delayed);
      delayed.length = 0;
    },
  };
}

function shouldDelayToolEventsUntilApproval(context: unknown, toolName: string): boolean {
  const tool = (context as ToolApprovalContext | undefined)?.toolPermissions?.getTool(toolName);
  return tool?.enabled === true && tool.autoApprove === false;
}

function isToolEventFor(event: PiAgentSessionEvent, toolName: string): boolean {
  return event.type === "tool" && event.toolName === toolName;
}

function isToolApprovalDecisionEnd(event: PiAgentSessionEvent): boolean {
  return event.type === "output_chunk" &&
    event.chunk.type === "output_item_end" &&
    typeof event.chunk.itemId === "string" &&
    event.chunk.itemId.startsWith("pi-agent-tool-approval-");
}

function isPendingToolApprovalError(error: unknown): error is workflow.HarnessError {
  return error instanceof workflow.HarnessError && error.type === "user_input_required";
}

export function createWorkflowToolPermissionExtension(
  context: unknown,
  emit?: PiAgentEventSink,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const workflowContext = context as ToolApprovalContext;
      const tool = workflowContext.toolPermissions?.getTool(event.toolName);
      if (event.toolName === KNOWLEDGE_DOCUMENTS_TOOL_NAME) {
        return undefined;
      }
      if (tool === undefined) {
        return undefined;
      }

      try {
        // uses Pi's tool_call extension hook as the pre-execution
        // checkpoint for built-in tools; the custom tool also guards its
        // execute() path for SDK versions that skip extension events.
        const decision = await workflow.createToolApprovalGate().approve({
          name: event.toolName,
          label: tool.label,
          description: tool.description,
          arguments: event.input,
        }, context as never);
        if (decision.requestId !== undefined) {
          emitToolApprovalDecision(emit, {
            toolName: event.toolName,
            label: tool.label,
            status: "approved",
            requestId: decision.requestId,
            arguments: event.input,
            values: decision.values,
          });
        }
        return undefined;
      } catch (error) {
        if (error instanceof workflow.HarnessError && error.type === "tool_permission_denied") {
          emitToolApprovalDecision(emit, {
            toolName: event.toolName,
            label: tool.label,
            status: "rejected",
            requestId: readApprovalRequestId(error),
            arguments: event.input,
            values: readApprovalValues(error),
            message: error.message,
          });
          return { block: true, reason: error.message };
        }
        throw error;
      }
    });
  };
}

function emitToolApprovalDecision(
  emit: PiAgentEventSink | undefined,
  input: Parameters<typeof createToolApprovalDecisionChunks>[0],
): void {
  for (const chunk of createToolApprovalDecisionChunks(input)) {
    emit?.({ type: "output_chunk", chunk });
  }
}

function readApprovalRequestId(error: workflow.HarnessError): string | undefined {
  const requestId = error.metadata?.["requestId"];
  return typeof requestId === "string" ? requestId : undefined;
}

function readApprovalValues(error: workflow.HarnessError): Record<string, unknown> | undefined {
  const values = error.metadata?.["values"];
  return isRecord(values) ? values : undefined;
}

export function createPiAgentSessionSnapshot(session: PiAgentSessionSnapshotSource): PiAgentSessionSnapshot {
  const stats = readSessionStats(session);
  return {
    sessionId: session.sessionId,
    messages: session.messages,
    activeTools: session.getActiveToolNames?.() ?? [],
    usage: readSessionUsage(stats),
  };
}

function readSessionStats(session: PiAgentSessionSnapshotSource): { tokens?: Record<string, unknown> } | undefined {
  // live SDK sessions expose getSessionStats(); keep getStats as a
  // compatibility fallback for older SDK builds used by local experiments.
  if (typeof session.getSessionStats === "function") {
    return session.getSessionStats();
  }
  if (typeof session.getStats === "function") {
    return session.getStats();
  }
  return undefined;
}

function normalizePiAgentEvent(event: PiAgentSdkEvent): PiAgentSessionEvent[] {
  if (event.type === "message_update") {
    const update = isRecord(event.assistantMessageEvent)
      ? event.assistantMessageEvent
      : undefined;
    if (update.type === "text_delta" && typeof update.delta === "string") {
      return [{ type: "text_delta", delta: update.delta }];
    }
  }

  if (event.type === "tool_execution_start") {
    return [{
      type: "tool",
      phase: "start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    }];
  }

  if (event.type === "tool_execution_update") {
    return [{
      type: "tool",
      phase: "update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
      partialResult: event.partialResult,
    }];
  }

  if (event.type === "tool_execution_end") {
    return [{
      type: "tool",
      phase: "end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    }];
  }

  return [];
}

function registerProviderRuntimeConfig(
  modelRegistry: PiModelRegistry,
  input: PiAgentParsedInput,
  apiKey: string | undefined,
): void {
  const hasBaseUrl = input.baseUrl !== undefined;
  const hasUnknownModel = input.model !== undefined && modelRegistry.find(input.provider, input.model) === undefined;
  if (!hasBaseUrl && !hasUnknownModel) {
    return;
  }

  modelRegistry.registerProvider(input.provider, {
    name: input.provider === "openai" ? "OpenAI" : "Anthropic",
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(hasUnknownModel && input.model !== undefined
      ? {
          api: input.provider === "openai" ? "openai-completions" : "anthropic-messages",
          models: [createRuntimeModelConfig(input.provider, input.model, input.baseUrl)],
        }
      : {}),
  });
}

function createRuntimeModelConfig(provider: PiAgentProvider, modelId: string, baseUrl: string | undefined) {
  return {
    id: modelId,
    name: modelId,
    api: provider === "openai" ? "openai-completions" : "anthropic-messages",
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    reasoning: provider === "anthropic",
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function readProviderApiKey(provider: PiAgentProvider, options: PiAgentRuntimeOptions): string | undefined {
  if (provider === "openai") {
    return readOptionalString(options.getEnv("OPENAI_API_KEY")) ??
      readOptionalString(options.getEnv("OPENAPI_API_KEY")) ??
      readOptionalString(options.getEnv("PI_OPENAI_API_KEY")) ??
      readOptionalString(options.getEnv("PI_API_KEY"));
  }

  return readOptionalString(options.getEnv("ANTHROPIC_API_KEY")) ??
    readOptionalString(options.getEnv("PI_ANTHROPIC_API_KEY")) ??
    readOptionalString(options.getEnv("PI_API_KEY")) ??
    readOptionalString(options.getEnv("OPENAI_API_KEY"));
}

function readSessionUsage(stats: { tokens?: Record<string, unknown> } | undefined): PiAgentUsage | undefined {
  const tokens = stats?.tokens;
  if (tokens === undefined) {
    return undefined;
  }

  const inputTokens = readOptionalNumber(tokens.input);
  const outputTokens = readOptionalNumber(tokens.output);
  const cacheReadTokens = readOptionalNumber(tokens.cacheRead);
  const cacheWriteTokens = readOptionalNumber(tokens.cacheWrite);
  const totalTokens = readOptionalNumber(tokens.total) ??
    sumDefined(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => value !== undefined);
  if (numbers.length === 0) {
    return undefined;
  }

  return numbers.reduce((sum, value) => sum + value, 0);
}

export function createPiAgentTokenUsageReport(snapshot: PiAgentSessionSnapshot) {
  const usage = snapshot.usage;
  if (usage === undefined) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheWriteTokens,
    providerName: "pi",
    metadata: {
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    },
  };
}
