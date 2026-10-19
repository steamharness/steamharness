import {
  Agent,
  imageGenerationTool,
  Runner,
  setDefaultOpenAIClient,
  setTraceProcessors,
  setTracingDisabled,
  shellTool,
  tool,
  type FunctionTool,
  type Tool,
  webSearchTool,
} from "@openai/agents";
import OpenAI from "openai";
import { z } from "zod";
import { createKnowledgeDocumentsTool } from "./knowledge-documents-tool";
import { createControlledLocalShell, resolveLocalShellWorkdir } from "./local-shell";
import { createTestTool } from "./test-tool";
import type {
  AgentFact,
  AgentRunDetails,
  AgentRunUsage,
  AgentToolCallSummary,
  ConversationMessageSnapshot,
  ConversationSnapshot,
  OpenAIAgentsRunnerResult,
  OpenAIAgentsInput,
  OpenAIAgentsOutputPayload,
  OpenAIAgentsParsedInput,
  OpenAIAgentsRunInput,
} from "./interface";

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_WORKDIR = ".";
const DEFAULT_AGENT_NAME = "steamharness-openai-agents";
const RUN_COUNT_KEY = "openaiAgents.runCount";
const FACTS_KEY = "openaiAgents.facts";
const HISTORY_KEY = "openaiAgents.history";
const OPENAI_AGENTS_TOOL_NAMES = [
  "web_search",
  "image_generation",
  "local_shell",
  "test_tool",
  "knowledge_documents",
  "remember_fact",
  "read_context",
  "custom_tools",
];
const toolApproval = workflow.createToolApprovalGate();

disableOpenAIAgentsTracing();

interface NodeRunContext {
  storage: {
    local: {
      kv: {
        conversation: {
          getValue(key: string): Promise<unknown | undefined>;
          setValue(key: string, value: unknown): Promise<void>;
        };
      };
      persistentValue: {
        workflow: {
          getValue(key: string): Promise<unknown | undefined>;
          setValue(key: string, value: unknown): Promise<void>;
          updateValue(key: string, updater: (current: unknown | undefined) => unknown): Promise<unknown>;
        };
      };
    };
  };
  conversation: {
    getValue(): Promise<{
      conversationId: string;
      messages: Array<{ role: string; content: string }>;
    }>;
    appendMessage(message: {
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      metadata?: Record<string, unknown>;
    }): Promise<unknown>;
    setTitle(title: string): Promise<unknown>;
  };
  tokenUsage: {
    report(input: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
      cacheCreationTokens?: number;
      nodeName?: string;
      providerName?: string;
      modelId?: string;
      metadata?: Record<string, unknown>;
    }): Promise<unknown>;
  };
  toolPermissions?: {
    getTool(name: string): {
      enabled: boolean;
      autoApprove: boolean;
      label?: string;
      description?: string;
    } | undefined;
  };
  abortSignal?: AbortSignal;
}

const inputNode = workflow.createInputNode<OpenAIAgentsInput, OpenAIAgentsParsedInput>({
  name: "openai-agents-input",
  parse(input) {
    const message = input.message.trim();
    if (message === "") {
      throw new workflow.HarnessError({
        type: "input_validation",
        message: "Message is required.",
        nodeName: "openai-agents-input",
      });
    }

    return {
      message,
      model: normalizeOptionalString(input.model) ?? DEFAULT_MODEL,
      workdir: normalizeOptionalString(input.workdir) ?? DEFAULT_WORKDIR,
      localShell: input.localShell === true,
      agentName: normalizeOptionalString(input.agentName) ?? DEFAULT_AGENT_NAME,
      instructions: normalizeInstructions(input.instructions),
      defaultTools: input.defaultTools !== false,
      memoryTools: input.memoryTools !== false,
      knowledgeTools: input.knowledgeTools !== false,
      testTool: input.testTool !== false,
      writeConversation: input.writeConversation !== false,
      writeAgentState: input.writeAgentState !== false,
      customTools: Array.isArray(input.customTools) ? input.customTools : [],
      agentRunner: input.agentRunner,
      streamRecorder: input.streamRecorder,
    };
  },
});

interface OpenAIAgentsStreamResult {
  answer: string;
  details: AgentRunDetails;
}

interface OpenAIAgentsStreamRunInput extends OpenAIAgentsRunInput {
  __streamResult?: OpenAIAgentsStreamResult;
}

interface OpenAIAgentsTextStreamEvent {
  type: "text_delta";
  delta: string;
}

interface OpenAIAgentsResultStreamEvent {
  type: "result";
  result: OpenAIAgentsStreamResult;
}

interface OpenAIAgentsErrorStreamEvent {
  type: "error";
  error: unknown;
}

interface OpenAIAgentsOutputChunkStreamEvent {
  type: "output_chunk";
  chunk: unknown;
}

type OpenAIAgentsStreamEvent =
  | OpenAIAgentsTextStreamEvent
  | OpenAIAgentsResultStreamEvent
  | OpenAIAgentsErrorStreamEvent
  | OpenAIAgentsOutputChunkStreamEvent;

interface OpenAIAgentsToolOutputRun {
  id: string;
  name: string;
  args: unknown;
  callId?: string;
  startedAt: string;
  startedAtMs: number;
  startReady: Promise<void>;
}

interface OpenAIAgentsToolOutputReporter {
  start(name: string, args: unknown, options?: { callId?: string; visible?: boolean }): Promise<OpenAIAgentsToolOutputRun>;
  startFromSdkToolCall(toolCall: unknown, fallbackName?: string): Promise<void>;
  approval(input: {
    name: string;
    label?: string;
    status: "approved" | "rejected";
    requestId?: string;
    reason?: string;
    message?: string;
    arguments?: unknown;
    values?: Record<string, unknown>;
  }): Promise<void>;
  finish(input: {
    run: OpenAIAgentsToolOutputRun;
    status: "completed" | "failed";
    result: unknown;
  }): Promise<void>;
}

interface AgentsSdkRunResultSnapshot {
  finalOutput?: unknown;
  lastResponseId?: string;
  newItems?: unknown[];
  history?: unknown[];
  runContext?: {
    usage?: unknown;
  };
}

interface AgentsSdkStreamedRunResult extends AgentsSdkRunResultSnapshot {
  completed: Promise<void>;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

interface AgentsSdkRunnerLike {
  run(
    agent: Agent<any, any>,
    message: string,
    options: {
      context: unknown;
      signal?: AbortSignal;
      stream: boolean;
      maxTurns: number;
    },
  ): Promise<AgentsSdkRunResultSnapshot | AgentsSdkStreamedRunResult>;
}

const outputNode = workflow.createOutputNode<OpenAIAgentsStreamRunInput, OpenAIAgentsOutputPayload>({
  name: "openai-agents-output",
  async *stream(input, context) {
    const itemId = "openai-agents-answer";
    let answerStarted = false;
    let answerEnded = false;
    const preRunChunks: unknown[] = [];
    const preRunToolReporter = createToolOutputReporter({
      async onOutputChunk(chunk) {
        preRunChunks.push(chunk);
      },
    });

    await approveOpenAIAgentsRunTools({ input, context, toolReporter: preRunToolReporter });
    for (const chunk of preRunChunks) {
      yield chunk;
    }
    const stream = createAgentResultStream(input, context);
    for await (const event of stream) {
      if (event.type === "text_delta") {
        if (!answerStarted) {
          answerStarted = true;
          yield createAnswerItemStartChunk(itemId);
        }
        await input.streamRecorder?.onTextDelta?.(event.delta);
        yield workflow.createOutputItemChunk({
          type: "output_item_delta",
          itemId,
          delta: event.delta,
        });
      } else if (event.type === "result") {
        input.__streamResult = event.result;
        const answer = event.result.answer.trim();
        if (!answerStarted && answer !== "") {
          answerStarted = true;
          answerEnded = true;
          yield createAnswerItemStartChunk(itemId);
          yield workflow.createOutputItemChunk({
            type: "output_item_delta",
            itemId,
            delta: answer,
          });
          yield workflow.createOutputItemChunk({ type: "output_item_end", itemId });
        }
      } else if (event.type === "output_chunk") {
        yield event.chunk;
      } else {
        throw event.error;
      }
    }

    if (answerStarted && !answerEnded) {
      yield workflow.createOutputItemChunk({ type: "output_item_end", itemId });
    }
  },
  async format(stream, input, context) {
    const runResult = requireOpenAIAgentsStreamResult(input.__streamResult);
    const answer = runResult.answer.trim() || "No response.";

    if (input.writeAgentState) {
      await context.storage.local.kv.conversation.setValue(RUN_COUNT_KEY, input.runCount);
      await context.storage.local.kv.conversation.setValue(FACTS_KEY, runResult.details.facts);
      await context.storage.local.kv.conversation.setValue(HISTORY_KEY, {
        mode: runResult.details.mode,
        historyLength: runResult.details.historyLength,
        lastResponseId: runResult.details.lastResponseId,
        localShell: runResult.details.localShell,
        updatedAt: new Date().toISOString(),
      });
    }
    if (input.writeConversation) {
      await context.conversation.appendMessage({
        role: "user",
        content: input.message,
        metadata: {
          model: input.model,
          workdir: input.workdir,
          localShell: input.localShell,
        },
      });
      await context.conversation.appendMessage({
        role: "assistant",
        content: answer,
        metadata: {
          mode: runResult.details.mode,
          model: input.model,
          toolCalls: runResult.details.toolCalls,
        },
      });
      await context.conversation.setTitle(createConversationTitle(input, input.conversation));
    }
    await reportTokenUsage(context, input, runResult.details.usage);

    const state = await context.conversation.getValue();
    const streamedItems = stream.items.map((item) => item.id === "openai-agents-answer"
        ? {
          ...item,
          content: answer,
          contentType: "markdown" as const,
          collapsed: false,
        }
        : item);
    const items = streamedItems.some((item) => item.id === "openai-agents-answer")
      ? streamedItems
      : [
          ...streamedItems,
          {
            id: "openai-agents-answer",
            title: "Output",
            content: answer,
            contentType: "markdown" as const,
            collapsed: false,
          },
        ];

    return {
      ...workflow.createOutputPayload({
        items: items.filter((item) => item.id !== "openai-agents-run-result"),
      }),
      mode: runResult.details.mode,
      model: input.model,
      workdir: input.workdir,
      localShell: runResult.details.localShell,
      conversationId: state.conversationId,
      conversationMessages: state.messages.length,
      runCount: input.runCount,
      facts: runResult.details.facts,
      historyLength: runResult.details.historyLength,
      toolCalls: runResult.details.toolCalls,
    };
  },
});

export const openaiAgentsWorkflow = workflow.defineWorkflow<OpenAIAgentsInput, OpenAIAgentsOutputPayload>({
  name: "openai-agents",
  async run(input, context) {
    const parsed = await workflow.runNode(inputNode, input, context) as OpenAIAgentsParsedInput;
    const state = await context.conversation.getValue();
    const runCount = Number(await context.storage.local.kv.conversation.getValue(RUN_COUNT_KEY) ?? 0) + 1;
    const facts = readAgentFacts(await context.storage.local.kv.conversation.getValue(FACTS_KEY));
    const result = await workflow.runStreamNode(
      outputNode,
      {
        ...parsed,
        conversation: createConversationSnapshot(state),
        runCount,
        facts,
      },
      context,
    );

    return requireOpenAIAgentsOutput(result.output);
  },
});

export const executor = workflow.defineExecutor<OpenAIAgentsInput, OpenAIAgentsOutputPayload>({
  projectType: "conversation",
  workflow: openaiAgentsWorkflow,
  tokenUsage: {
    enabled: true,
    display: true,
  },
  tools: [
    {
      name: "web_search",
      label: "Web Search",
      description: "Use the OpenAI hosted web search tool.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "image_generation",
      label: "Image Generation",
      description: "Use the OpenAI hosted image generation tool.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "local_shell",
      label: "Local Shell",
      description: "Run small controlled shell commands in the configured workdir.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "test_tool",
      label: "HTTP Test Tool",
      description: "Send a small HTTP GET or POST request for workflow connectivity tests.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "knowledge_documents",
      label: "Knowledge Documents",
      description: "Manage PersistentValue-backed project markdown knowledge documents.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "remember_fact",
      label: "Remember Fact",
      description: "Write a short conversation-scoped fact into workflow KV.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "read_context",
      label: "Read Context",
      description: "Read recent conversation context and remembered facts.",
      enabled: true,
      autoApprove: true,
    },
    {
      name: "custom_tools",
      label: "Custom Tools",
      description: "Allow custom OpenAI Agents SDK tools supplied by a reusable parent workflow.",
      enabled: true,
      autoApprove: true,
    },
  ],
  params: [
    {
      kind: "auxiliary",
      id: "advanced",
      label: "Advanced",
      fields: [
        {
          name: "model",
          flag: "--model",
          type: "string",
          required: false,
          defaultValue: "gpt-5.4",
          description: "OpenAI model passed to the Agent.",
        },
        {
          name: "workdir",
          flag: "--workdir",
          shortFlag: "-C",
          type: "string",
          required: false,
          defaultValue: ".",
          description: "Current execution directory path passed into the Agents SDK context.",
        },
        {
          name: "localShell",
          flag: "--local-shell",
          type: "boolean",
          required: false,
          defaultValue: "false",
          description: "Enable the Agents SDK local shellTool sample. Requires a shell-tool-compatible OpenAI endpoint.",
        }
      ],
    },
  ],
  createInput({ args }) {
    return parseInput(args);
  },
});

export { openaiAgentsWorkflow as workflow };
export default openaiAgentsWorkflow;

async function runLiveAgent(
  input: OpenAIAgentsRunInput,
  context: NodeRunContext,
  events: {
    onTextDelta(delta: string): Promise<void>;
    onOutputChunk(chunk: unknown): Promise<void>;
  },
): Promise<OpenAIAgentsStreamResult> {
  const apiKey = normalizeOptionalString(workflow.getEnv("OPENAI_API_KEY")) ?? normalizeOptionalString(workflow.getEnv("LLM_API_KEY"));
  if (apiKey === undefined && input.agentRunner === undefined) {
    throw new workflow.HarnessError({
      type: "input_validation",
      message: "OPENAI_API_KEY or LLM_API_KEY is required for OpenAI Agents SDK runs.",
      nodeName: "openai-agents-output",
    });
  }
  const baseURL = normalizeOptionalString(workflow.getEnv("OPENAI_BASE_URL")) ?? normalizeOptionalString(workflow.getEnv("LLM_BASE_URL"));
  const shellWorkdir = input.localShell ? resolveAgentShellWorkdir(input.workdir) : input.workdir;

  const toolEvents: AgentToolCallSummary[] = [];
  const facts = [...input.facts];
  const sdkContext = {
    projectName: "openai-agents",
    conversationId: input.conversation.conversationId,
    messages: input.conversation.messages,
    runCount: input.runCount,
    message: input.message,
    workdir: shellWorkdir,
    facts,
  };
  const visibleTextDeltas: string[] = [];
  const visibleEvents = createVisibleTextRecorder(events, visibleTextDeltas);
  const toolReporter = createToolOutputReporter(visibleEvents);
  const agentTools = createOpenAIAgentTools({
    input,
    context,
    sdkContext,
    shellWorkdir,
    facts,
    toolEvents,
    toolReporter,
  });

  if (apiKey !== undefined) {
    setDefaultOpenAIClient(new OpenAI({ apiKey, baseURL }));
  }
  const agent = new Agent<typeof sdkContext>({
    name: input.agentName,
    model: input.model,
    instructions(runContext) {
      const baseInstructions = [
        "You are a concise steamharness sample agent.",
        ...input.instructions,
        input.memoryTools
          ? "Use read_context before answering when the user asks about prior state."
          : "The read_context tool is disabled for this run.",
        input.memoryTools
          ? "Use remember_fact when the user explicitly asks you to remember a durable preference or fact."
          : "The remember_fact tool is disabled for this run.",
        input.knowledgeTools
          ? "Use knowledge_documents to list, read, create, edit, delete, search, or read line ranges from the project's PersistentValue-backed markdown knowledge documents."
          : "The knowledge_documents tool is disabled for this run.",
        input.testTool
          ? "Use test_tool when the user asks to make a small HTTP connectivity test or inspect a test endpoint."
          : "The test_tool tool is disabled for this run.",
        input.defaultTools
          ? "You may use web search or image generation when they help answer the user."
          : "Hosted web search and image generation tools are disabled for this run.",
        input.localShell
          ? "You may use local_shell for small, safe local commands inside the configured workdir."
          : "The local_shell tool is disabled for this run.",
        "Answer in the user's language. Keep the final answer short.",
        `Workflow context: ${JSON.stringify(summarizeAgentContext(runContext.context))}`,
      ];
      return baseInstructions.filter((line) => line.trim() !== "").join("\n");
    },
    tools: agentTools,
  });

  const result = await runAgent(input, {
    agent,
    message: input.message,
    context: sdkContext,
    signal: context.abortSignal,
    tools: agentTools,
  }, {
    ...visibleEvents,
    async onStreamEvent(event) {
      const toolCall = readSdkToolCallFromStreamEvent(event);
      if (toolCall !== undefined) {
        await toolReporter.startFromSdkToolCall(toolCall);
      }
    },
  });
  const usage = readAgentUsage(result.usage ?? readRunContextUsage(result));
  const answer = buildVisibleAnswer(visibleTextDeltas, result);

  return {
    answer,
    details: {
      mode: "live",
      model: input.model,
      workdir: input.workdir,
      baseURL,
      localShell: input.localShell,
      lastResponseId: result.lastResponseId,
      toolCalls: mergeToolCalls(toolEvents, readToolCalls(result.newItems ?? [])),
      usage,
      historyLength: result.history?.length ?? 0,
      conversationId: input.conversation.conversationId,
      runCount: input.runCount,
      facts,
    },
  };
}

function buildVisibleAnswer(
  visibleTextDeltas: string[],
  result: OpenAIAgentsRunnerResult,
): string {
  const visibleText = visibleTextDeltas.join("").trim();
  const finalOutput = String(result.finalOutput ?? "").trim();
  return visibleText || finalOutput;
}

function createAgentResultStream(
  input: OpenAIAgentsRunInput,
  context: NodeRunContext,
): AsyncIterable<OpenAIAgentsStreamEvent> {
  const queue = createAsyncEventQueue<OpenAIAgentsStreamEvent>();
  void runLiveAgent(input, context, {
    async onTextDelta(delta) {
      if (delta !== "") {
        queue.push({ type: "text_delta", delta });
      }
    },
    async onOutputChunk(chunk) {
      queue.push({ type: "output_chunk", chunk });
    },
  }).then(
    (result) => {
      queue.push({ type: "result", result });
      queue.end();
    },
    (error) => {
      queue.push({ type: "error", error });
      queue.end();
    },
  );
  return queue;
}

function createVisibleTextRecorder(
  events: {
    onTextDelta(delta: string): Promise<void>;
    onOutputChunk(chunk: unknown): Promise<void>;
  },
  deltas: string[] = [],
): {
  onTextDelta(delta: string): Promise<void>;
  onOutputChunk(chunk: unknown): Promise<void>;
} {
  return {
    async onTextDelta(delta) {
      deltas.push(delta);
      await events.onTextDelta(delta);
    },
    async onOutputChunk(chunk) {
      await events.onOutputChunk(chunk);
    },
  };
}

export function createOpenAIAgentTools(input: {
  input: OpenAIAgentsRunInput;
  context: NodeRunContext;
  sdkContext: {
    projectName: string;
    conversationId?: string;
    messages: ConversationMessageSnapshot[];
    runCount: number;
    message: string;
    workdir: string;
    facts: AgentFact[];
  };
  shellWorkdir?: string;
  facts?: AgentFact[];
  toolEvents?: AgentToolCallSummary[];
  toolReporter?: OpenAIAgentsToolOutputReporter;
}): Tool[] {
  const toolEvents = input.toolEvents ?? [];
  const facts = input.facts ?? input.input.facts;
  const tools: Tool[] = [];
  const isEnabled = (name: string) => isOpenAIAgentsToolEnabled(input.context, name);

  if (input.input.defaultTools) {
    if (isEnabled("web_search")) {
      tools.push(webSearchTool({
        externalWebAccess: true,
      }));
    }
    if (isEnabled("image_generation")) {
      tools.push(imageGenerationTool());
    }
  }

  if (isEnabled("local_shell")) {
    tools.push(...createLocalShellTools({
      enabled: input.input.localShell,
      workdir: input.shellWorkdir ?? input.input.workdir,
      context: input.context,
      signal: input.context.abortSignal,
      toolEvents,
      toolReporter: input.toolReporter,
    }));
  }

  if (input.input.testTool && isEnabled("test_tool")) {
    tools.push(
      createTestTool({
        signal: input.context.abortSignal,
        toolEvents,
      }) as Tool,
    );
  }

  if (input.input.knowledgeTools && isEnabled("knowledge_documents")) {
    tools.push(createKnowledgeDocumentsTool({
      context: input.context,
      toolEvents,
    }) as Tool);
  }

  if (input.input.memoryTools) {
    if (isEnabled("remember_fact")) {
      tools.push(tool({
        name: "remember_fact",
        description: "Remember a short conversation-scoped fact in workflow KV.",
        parameters: z.object({
          key: z.string().min(1).max(80),
          value: z.string().min(1).max(500),
        }),
        async execute(args) {
          const fact = upsertFact(facts, {
            key: args.key,
            value: args.value,
            updatedAt: new Date().toISOString(),
          });
          await input.context.storage.local.kv.conversation.setValue(FACTS_KEY, facts);
          toolEvents.push({ name: "remember_fact", status: "completed" });
          return {
            remembered: true,
            fact,
            factCount: facts.length,
          };
        },
      }));
    }
    if (isEnabled("read_context")) {
      tools.push(tool({
        name: "read_context",
        description: "Read workflow conversation context and remembered facts.",
        parameters: z.object({}),
        execute() {
          toolEvents.push({ name: "read_context", status: "completed" });
          return summarizeAgentContext({ ...input.sdkContext, facts });
        },
      }));
    }
  }

  return wrapFunctionToolsForOutput([
    ...tools,
    ...(isEnabled("custom_tools") ? input.input.customTools as Tool[] : []),
  ], input.toolReporter, input.context);
}

export async function approveOpenAIAgentsRunTools(input: {
  input: OpenAIAgentsRunInput;
  context: NodeRunContext;
  toolReporter?: OpenAIAgentsToolOutputReporter;
}): Promise<void> {
  if (!input.input.defaultTools) {
    return;
  }

  await approveOpenAIAgentsHostedToolForRun(input.context, "web_search", {
    toolReporter: input.toolReporter,
  });
  await approveOpenAIAgentsHostedToolForRun(input.context, "image_generation", {
    toolReporter: input.toolReporter,
  });
}

function createAnswerItemStartChunk(itemId: string) {
  return workflow.createOutputItemChunk({
    type: "output_item_start",
    item: {
      id: itemId,
      title: "Output",
      content: "",
      contentType: "markdown",
      collapsed: false,
    },
  });
}

function createToolOutputReporter(events: {
  onOutputChunk(chunk: unknown): Promise<void>;
}): OpenAIAgentsToolOutputReporter {
  let sequence = 0;
  const runsByCallId = new Map<string, OpenAIAgentsToolOutputRun>();

  const reporter: OpenAIAgentsToolOutputReporter = {
    async start(name, args, options = {}) {
      const callId = normalizeOptionalString(options.callId);
      const existing = callId === undefined ? undefined : runsByCallId.get(callId);
      if (existing !== undefined) {
        await existing.startReady;
        return existing;
      }

      sequence += 1;
      const visible = options.visible !== false;
      const run: OpenAIAgentsToolOutputRun = {
        id: `openai-agents-tool-${sequence}-${normalizeOutputItemIdSegment(name)}`,
        name,
        args: redactSensitiveValue(args),
        callId,
        startedAt: new Date().toISOString(),
        startedAtMs: Date.now(),
        startReady: Promise.resolve(),
      };

      if (callId !== undefined) {
        runsByCallId.set(callId, run);
      }

      run.startReady = visible
        ? (async () => {
            await events.onOutputChunk(workflow.createOutputItemChunk({
              type: "output_item_start",
              item: {
                id: run.id,
                title: `Tool: ${name}`,
                content: formatToolStartMarkdown(run),
                contentType: "markdown",
                iconPreset: "code",
                collapsed: true,
                metadata: {
                  kind: "openai-agents-tool-call",
                  toolName: name,
                  status: "running",
                  startedAt: run.startedAt,
                },
              },
            }));
            await waitForOutputChunkFlushOpportunity();
          })()
        : Promise.resolve();

      await run.startReady;
      return run;
    },
    async startFromSdkToolCall(toolCall, fallbackName) {
      const start = readToolCallStart(toolCall, fallbackName);
      if (start === undefined) {
        return;
      }
      await reporter.start(start.name, start.args, { callId: start.callId });
    },
    async approval(input) {
      sequence += 1;
      const itemId = `openai-agents-tool-approval-${sequence}-${normalizeOutputItemIdSegment(input.name)}`;
      const displayName = normalizeOptionalString(input.label) ?? input.name;
      const statusText = input.status === "approved" ? "已批准" : "已拒绝";
      await events.onOutputChunk(workflow.createOutputItemChunk({
        type: "output_item_start",
        item: {
          id: itemId,
          title: `工具权限审批 · ${displayName} · ${statusText}`,
          content: formatToolApprovalMarkdown({
            ...input,
            displayName,
            statusText,
            arguments: redactSensitiveValue(input.arguments),
          }),
          contentType: "markdown",
          iconPreset: input.status === "approved" ? "success" : "error",
          collapsed: false,
          metadata: {
            kind: "openai-agents-tool-approval",
            toolName: input.name,
            status: input.status,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          },
        },
      }));
      await events.onOutputChunk(workflow.createOutputItemChunk({
        type: "output_item_end",
        itemId,
      }));
      await waitForOutputChunkFlushOpportunity();
    },
    async finish({ run, status, result }) {
      await run.startReady;
      const endedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.now() - run.startedAtMs);
      const uiStatus = status === "completed" ? "success" : "failed";
      await events.onOutputChunk(workflow.createOutputItemChunk({
        type: "output_item_delta",
        itemId: run.id,
        delta: formatToolFinishMarkdown({
          status,
          result: redactSensitiveValue(result),
          endedAt,
          durationMs,
        }),
        item: {
          title: `Tool: ${run.name}`,
          iconPreset: status === "completed" ? "success" : "error",
          metadata: {
            kind: "openai-agents-tool-call",
            toolName: run.name,
            status: uiStatus,
            outcome: status,
            startedAt: run.startedAt,
            endedAt,
            durationMs,
          },
        },
      }));
      await events.onOutputChunk(workflow.createOutputItemChunk({
        type: "output_item_end",
        itemId: run.id,
      }));
    },
  };

  return reporter;
}

function waitForOutputChunkFlushOpportunity(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function wrapFunctionToolsForOutput(
  tools: Tool[],
  reporter: OpenAIAgentsToolOutputReporter | undefined,
  context?: NodeRunContext,
): Tool[] {
  if (reporter === undefined && context === undefined) {
    return tools;
  }

  return tools.map((agentTool) => isInvokableFunctionTool(agentTool)
    ? wrapFunctionToolForOutput(agentTool, reporter, context) as Tool
    : agentTool);
}

function wrapFunctionToolForOutput<Context>(
  agentTool: FunctionTool<Context, any, any>,
  reporter: OpenAIAgentsToolOutputReporter | undefined,
  context: NodeRunContext | undefined,
): FunctionTool<Context, any, any> {
  return {
    ...agentTool,
    async invoke(runContext, rawInput, details) {
      const args = parseToolInput(rawInput);
      await approveOpenAIAgentsFunctionTool(context, agentTool.name, args, {
        toolReporter: reporter,
      });
      const outputRun = await reporter?.start(agentTool.name, args, {
        callId: readToolCallId(readToolCallFromDetails(details)),
      });
      try {
        const result = await agentTool.invoke(runContext, rawInput, details);
        if (outputRun !== undefined) {
          await reporter?.finish({
            run: outputRun,
            status: "completed",
            result,
          });
        }
        return result;
      } catch (error) {
        if (outputRun !== undefined) {
          await reporter?.finish({
            run: outputRun,
            status: "failed",
            result: serializeToolError(error),
          });
        }
        throw error;
      }
    },
  };
}

function isInvokableFunctionTool(value: Tool): value is FunctionTool<any, any, any> {
  return isRecord(value) &&
    value.type === "function" &&
    typeof value.name === "string" &&
    typeof value.invoke === "function";
}

function parseToolInput(rawInput: string): unknown {
  try {
    return JSON.parse(rawInput);
  } catch {
    return rawInput;
  }
}

function formatToolStartMarkdown(run: OpenAIAgentsToolOutputRun): string {
  return [
    `**工具调用** \`${run.name}\``,
    "",
    "状态：运行中",
    `开始时间：${run.startedAt}`,
    "",
    "**参数**",
    formatMarkdownValue(run.args),
  ].join("\n");
}

function formatToolFinishMarkdown(input: {
  status: "completed" | "failed";
  result: unknown;
  endedAt: string;
  durationMs: number;
}): string {
  const statusText = input.status === "completed" ? "完成" : "失败";
  return [
    "",
    `状态：${statusText}`,
    `结束时间：${input.endedAt}`,
    `耗时：${input.durationMs}ms`,
    "",
    "**结果**",
    formatMarkdownValue(input.result),
  ].join("\n");
}

function formatToolApprovalMarkdown(input: {
  name: string;
  displayName: string;
  status: "approved" | "rejected";
  statusText: string;
  requestId?: string;
  reason?: string;
  message?: string;
  arguments?: unknown;
  values?: Record<string, unknown>;
}): string {
  const lines: string[] = [
    `**工具权限审批** \`${input.name}\``,
    "",
    `结果：${input.statusText}`,
  ];
  if (input.displayName !== input.name) {
    lines.push("");
    lines.push(`工具：${input.displayName}`);
  }
  if (input.reason) {
    lines.push("");
    lines.push(`原因：${input.reason}`);
  }
  if (input.message) {
    lines.push("");
    lines.push(`说明：${input.message}`);
  }
  if (input.requestId) {
    lines.push("");
    lines.push(`请求：\`${input.requestId}\``);
  }
  if (!isEmptyValue(input.arguments)) {
    lines.push("");
    lines.push("**参数**");
    lines.push(formatMarkdownValue(input.arguments));
  }
  if (!isEmptyValue(input.values)) {
    lines.push("");
    lines.push("**审批值**");
    lines.push(formatMarkdownValue(input.values));
  }
  return lines.join("\n");
}

function formatMarkdownValue(value: unknown): string {
  if (typeof value === "string") {
    return truncateToolOutput(value);
  }

  return [
    "```json",
    truncateToolOutput(safeJsonStringify(value)),
    "```",
  ].join("\n");
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== "object" || item === null) {
      return item;
    }
    if (seen.has(item)) {
      return "[Circular]";
    }
    seen.add(item);
    return item;
  }, 2) ?? "null";
}

function truncateToolOutput(value: string): string {
  const safe = value.replace(/```/g, "'''");
  const maxLength = 4_000;
  return safe.length <= maxLength ? safe : `${safe.slice(0, maxLength)}\n[tool output truncated]`;
}

function normalizeOutputItemIdSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "tool";
}

function serializeToolError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? "[redacted]" : redactSensitiveValue(item);
  }
  return redacted;
}

function isSensitiveKey(key: string): boolean {
  return /authorization|api[_-]?key|token|secret|password|cookie/i.test(key);
}

function readApprovalRequestId(error: workflow.HarnessError): string | undefined {
  const requestId = error.metadata?.["requestId"];
  return typeof requestId === "string" ? requestId : undefined;
}

function readApprovalValues(error: workflow.HarnessError): Record<string, unknown> | undefined {
  const values = error.metadata?.["values"];
  return isRecord(values) ? values : undefined;
}

async function runAgent(
  input: OpenAIAgentsRunInput,
  runnerInput: {
    agent: Agent<any, any>;
    message: string;
    context: unknown;
    signal?: AbortSignal;
    tools: Tool[];
  },
  events: {
    onTextDelta(delta: string): Promise<void>;
    onStreamEvent?(event: unknown): Promise<void>;
  },
): Promise<OpenAIAgentsRunnerResult> {
  if (input.agentRunner !== undefined) {
    const result = await input.agentRunner(runnerInput);
    await emitRunnerOutputChunks(result, events);
    return result;
  }

  const runner = new Runner({ tracingDisabled: true });
  runner.on("agent_tool_start", (_context, _agent, toolValue, details) => {
    const fallbackName = isRecord(toolValue) && typeof toolValue.name === "string"
      ? toolValue.name
      : undefined;
    void events.onStreamEvent?.({
      type: "steamharness_agent_tool_start",
      toolCall: details.toolCall,
      fallbackName,
    });
  });
  return runAgentWithStreamingFallback({
    stream: (streamEvents) => runAgentStream(runner, runnerInput, streamEvents),
    nonStream: () => runAgentNonStream(runner, runnerInput),
  }, events);
}

export async function runAgentWithStreamingFallback(
  runners: {
    stream(events: { onTextDelta(delta: string): Promise<void>; onStreamEvent?(event: unknown): Promise<void> }): Promise<OpenAIAgentsRunnerResult>;
    nonStream(): Promise<OpenAIAgentsRunnerResult>;
  },
  events: {
    onTextDelta(delta: string): Promise<void>;
    onStreamEvent?(event: unknown): Promise<void>;
  },
): Promise<OpenAIAgentsRunnerResult> {
  const textChunks: string[] = [];

  try {
    const result = await runners.stream({
      async onTextDelta(delta) {
        textChunks.push(delta);
        await events.onTextDelta(delta);
      },
      async onStreamEvent(event) {
        await events.onStreamEvent?.(event);
      },
    });

    return result;
  } catch (error) {
    const streamedText = textChunks.join("").trim();

    // When the stream has already pushed text deltas to the UI
    // (e.g. the OpenAI Agents SDK fails on `result.completed` *after* the
    // Responses stream has finished), the conversation still has a usable
    // answer. Falling back to the streamed text — even for unknown error
    // shapes — keeps the run from being marked failed after the user has
    // already seen the assistant's reply. The original error is still
    // recorded by the caller via the SDK trace and the report's error
    // chain.
    if (streamedText !== "") {
      return {
        finalOutput: streamedText,
        history: [],
        newItems: [],
      };
    }

    // When streaming fails without producing any text, fall back
    // to a non-stream run regardless of the error type. On Windows the
    // OpenAI Agents SDK can reject streaming for reasons beyond the known
    // Responses stream output error (e.g. runner.run() rejecting before
    // the text stream opens, reader.read() failing on a platform-specific
    // condition). The non-stream path is more reliable and deserves a
    // chance before the run is marked failed.
    const result = await runners.nonStream();
    await emitRunnerOutputChunks(result, events);
    return result;
  }
}

export async function runAgentStream(
  runner: AgentsSdkRunnerLike,
  runnerInput: {
    agent: Agent<any, any>;
    message: string;
    context: unknown;
    signal?: AbortSignal;
  },
  events: {
    onTextDelta(delta: string): Promise<void>;
    onStreamEvent?(event: unknown): Promise<void>;
  },
): Promise<OpenAIAgentsRunnerResult> {
  const result = await runner.run(runnerInput.agent, runnerInput.message, {
    context: runnerInput.context,
    signal: runnerInput.signal,
    stream: true,
    maxTurns: 3,
  }) as AgentsSdkStreamedRunResult;
  let streamedText = "";
  let visibleText = "";
  let currentResponseText = "";
  let bufferCurrentResponseText = false;
  let sawEmptyOutputTextResponse = false;

  for await (const event of result) {
    await events.onStreamEvent?.(event);

    if (isRawModelResponseStarted(event)) {
      currentResponseText = "";
      bufferCurrentResponseText = sawEmptyOutputTextResponse;
    }

    const rawValue = readRawModelOutputTextDelta(event);
    if (rawValue !== undefined) {
      const normalized = normalizeStreamingTextDelta(streamedText, rawValue);
      streamedText = normalized.text;
      if (normalized.delta !== "") {
        currentResponseText = `${currentResponseText}${normalized.delta}`;
        if (!bufferCurrentResponseText) {
          visibleText = `${visibleText}${normalized.delta}`;
          await events.onTextDelta(normalized.delta);
        }
      }
    }

    const responseOutput = readRawModelResponseDoneOutput(event);
    if (responseOutput !== undefined && currentResponseText.trim() !== "") {
      if (responseOutput.length > 0) {
        if (bufferCurrentResponseText) {
          visibleText = `${visibleText}${currentResponseText}`;
          await events.onTextDelta(currentResponseText);
        }
        sawEmptyOutputTextResponse = false;
      } else if (bufferCurrentResponseText) {
        break;
      } else {
        // Some OpenAI-compatible Responses endpoints stream text deltas but
        // finish with `response.output: []`. The Agents SDK then cannot resolve
        // a RunMessageOutputItem and may repeat the same turn. Keep the first
        // visible text, but buffer the next response so repeated text is not
        // emitted before we know whether the next turn is actually a tool call.
        sawEmptyOutputTextResponse = true;
      }
    }
  }

  await result.completed;

  return {
    finalOutput: readStreamedRunFinalOutput(result, visibleText),
    lastResponseId: result.lastResponseId,
    newItems: result.newItems,
    history: result.history,
    usage: result.runContext.usage,
  };
}

function isRawModelResponseStarted(event: unknown): boolean {
  return isRecord(event) &&
    event.type === "raw_model_stream_event" &&
    isRecord(event.data) &&
    event.data.type === "response_started";
}

function readRawModelOutputTextDelta(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "raw_model_stream_event" || !isRecord(event.data)) {
    return undefined;
  }

  return event.data.type === "output_text_delta" && typeof event.data.delta === "string"
    ? event.data.delta
    : undefined;
}

function readRawModelResponseDoneOutput(event: unknown): unknown[] | undefined {
  if (!isRecord(event) || event.type !== "raw_model_stream_event" || !isRecord(event.data)) {
    return undefined;
  }
  if (event.data.type !== "response_done" || !isRecord(event.data.response)) {
    return undefined;
  }

  const output = event.data.response.output;
  return Array.isArray(output) ? output : undefined;
}

function readSdkToolCallFromStreamEvent(event: unknown): unknown | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  if (event.type === "steamharness_agent_tool_start") {
    return isRecord(event.toolCall)
      ? event.toolCall
      : undefined;
  }

  if (event.type !== "run_item_stream_event" || event.name !== "tool_called" || !isRecord(event.item)) {
    return undefined;
  }

  return isRecord(event.item.rawItem)
    ? event.item.rawItem
    : undefined;
}

function readToolCallStart(toolCall: unknown, fallbackName?: string): {
  name: string;
  args: unknown;
  callId?: string;
} | undefined {
  if (!isRecord(toolCall) || toolCall.type !== "function_call") {
    return undefined;
  }

  const name = normalizeOptionalString(toolCall.name) ?? normalizeOptionalString(fallbackName);
  if (name === undefined) {
    return undefined;
  }

  const rawArgs = typeof toolCall.arguments === "string" ? toolCall.arguments : "{}";
  return {
    name,
    args: parseToolInput(rawArgs),
    callId: readToolCallId(toolCall),
  };
}

function readToolCallFromDetails(details: unknown): unknown | undefined {
  return isRecord(details) && isRecord(details.toolCall)
    ? details.toolCall
    : undefined;
}

function readToolCallId(toolCall: unknown): string | undefined {
  if (!isRecord(toolCall)) {
    return undefined;
  }

  return normalizeOptionalString(toolCall.callId) ?? normalizeOptionalString(toolCall.call_id) ?? normalizeOptionalString(toolCall.id);
}

async function runAgentNonStream(
  runner: Runner,
  runnerInput: {
    agent: Agent<any, any>;
    message: string;
    context: unknown;
    signal?: AbortSignal;
  },
): Promise<OpenAIAgentsRunnerResult> {
  const result = await runner.run(runnerInput.agent, runnerInput.message, {
    context: runnerInput.context,
    signal: runnerInput.signal,
    stream: false,
    maxTurns: 3,
  }) as AgentsSdkRunResultSnapshot;

  return {
    finalOutput: result.finalOutput ?? "",
    lastResponseId: result.lastResponseId,
    newItems: result.newItems,
    history: result.history,
    usage: result.runContext?.usage,
  };
}

async function emitRunnerOutputChunks(
  result: OpenAIAgentsRunnerResult,
  events: {
    onTextDelta(delta: string): Promise<void>;
  },
): Promise<void> {
  let emitted = false;
  let emittedText = "";
  if (result.outputChunks !== undefined) {
    for await (const chunk of result.outputChunks) {
      const normalized = normalizeStreamingTextDelta(emittedText, String(chunk));
      emittedText = normalized.text;
      if (normalized.delta !== "") {
        emitted = true;
        await events.onTextDelta(normalized.delta);
      }
    }
  }

  if (!emitted) {
    const answer = String(result.finalOutput ?? "");
    if (answer !== "") {
      await events.onTextDelta(answer);
    }
  }
}

export function normalizeStreamingTextDelta(
  previousText: string,
  nextChunk: string,
): {
  delta: string;
  text: string;
} {
  if (nextChunk === "") {
    return { delta: "", text: previousText };
  }

  // Provider replays the accumulated text as a single chunk
  // ("你好" then "你好！有什么可以帮你？").
  if (previousText !== "" && nextChunk.length > previousText.length && nextChunk.startsWith(previousText)) {
    return {
      delta: nextChunk.slice(previousText.length),
      text: nextChunk,
    };
  }

  // Exact duplicate chunk (any length).
  if (nextChunk === previousText) {
    return { delta: "", text: previousText };
  }

  return {
    delta: nextChunk,
    text: `${previousText}${nextChunk}`,
  };
}

function readStreamedRunFinalOutput(
  result: AgentsSdkStreamedRunResult,
  streamedText: string,
): unknown {
  const state = isRecord(result) && isRecord(result.state)
    ? result.state
    : undefined;
  const currentStep = state && isRecord(state._currentStep)
    ? state._currentStep
    : undefined;
  const finalOutput = currentStep?.type === "next_step_final_output"
    ? result.finalOutput
    : undefined;

  if (typeof finalOutput === "string") {
    return finalOutput.trim() !== "" ? finalOutput : streamedText;
  }

  if (finalOutput === undefined && streamedText !== "") {
    return streamedText;
  }

  return finalOutput;
}

export function isKnownAgentsResponsesStreamOutputError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error instanceof TypeError &&
    error.message.includes("Cannot read properties of undefined") &&
    error.message.includes("map") &&
    String(error.stack ?? "").includes("openaiResponsesModel");
}

export function disableOpenAIAgentsTracing(): void {
  setTracingDisabled(true);
  setTraceProcessors([]);
}

function requireOpenAIAgentsOutput(value: OpenAIAgentsOutputPayload | undefined): OpenAIAgentsOutputPayload {
  if (value === undefined) {
    throw new workflow.HarnessError({
      type: "node_execution",
      message: "OpenAI Agents output node did not return an output payload.",
      nodeName: "openai-agents-output",
    });
  }

  return value;
}

function requireOpenAIAgentsStreamResult(value: OpenAIAgentsStreamResult | undefined): OpenAIAgentsStreamResult {
  if (value === undefined) {
    throw new workflow.HarnessError({
      type: "node_execution",
      message: "OpenAI Agents stream finished without run details.",
      nodeName: "openai-agents-output",
    });
  }

  return value;
}

function createAsyncEventQueue<T>(): AsyncIterable<T> & {
  push(value: T): void;
  end(): void;
} {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let ended = false;

  return {
    push(value: T) {
      if (ended) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter({ value, done: false });
        return;
      }
      values.push(value);
    },
    end() {
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          const value = values.shift();
          if (value !== undefined) {
            return Promise.resolve({ value, done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };
}

function resolveAgentShellWorkdir(workdir: string): string {
  try {
    return resolveLocalShellWorkdir(workdir);
  } catch (cause) {
    throw new workflow.HarnessError({
      type: "input_validation",
      message: `Invalid --workdir: ${cause instanceof Error ? cause.message : String(cause)}`,
      nodeName: "openai-agents-output",
      cause,
    });
  }
}

async function reportTokenUsage(
  context: NodeRunContext,
  input: OpenAIAgentsRunInput,
  usage: AgentRunUsage,
): Promise<void> {
  await context.tokenUsage.report({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    nodeName: "openai-agents-output",
    providerName: "openai-agents-sdk",
    modelId: input.model,
    metadata: {
      mode: "live",
      requests: usage.requests,
      workdir: input.workdir,
    },
  });
}

function parseInput(args: string[]): OpenAIAgentsInput {
  const defaults = workflow.parseConversationDefaultInputArgs(args);
  const defaultMessage = defaults.message.trim();
  let message = defaults.message;
  let model: string | undefined;
  let workdir: string | undefined;
  let localShell = false;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--model") {
      model = args[++index];
    } else if (arg === "--workdir" || arg === "--cwd" || arg === "--cd" || arg === "-C") {
      workdir = args[++index];
    } else if (arg === "--local-shell") {
      localShell = true;
    } else if (defaultMessage === "") {
      positional.push(arg);
    }
  }

  if (defaultMessage === "" && message === "" && positional.length > 0) {
    message = positional.join(" ");
  }

  return { message, model, workdir, localShell };
}

function createLocalShellTools(input: {
  enabled: boolean;
  workdir: string;
  context: NodeRunContext;
  signal?: AbortSignal;
  toolEvents: AgentToolCallSummary[];
  toolReporter?: OpenAIAgentsToolOutputReporter;
}) {
  if (!input.enabled) {
    return [];
  }

  return [
    shellTool({
      name: "local_shell",
      environment: {
        type: "local",
      },
      shell: createControlledLocalShell({
        workdir: input.workdir,
        signal: input.signal,
        onCommand(event) {
          input.toolEvents.push({ name: "local_shell", status: event.status });
        },
      }),
      needsApproval: async (_runContext, action) => {
        const tool = input.context.toolPermissions?.getTool("local_shell");
        if (tool === undefined) {
          return false;
        }
        return !tool.autoApprove;
      },
      onApproval: async (_runContext, approvalItem) => {
        try {
          await approveOpenAIAgentsTool(input.context, "local_shell", readShellApprovalArguments(approvalItem), {
            toolReporter: input.toolReporter,
          });
          return { approve: true };
        } catch (error) {
          if (error instanceof workflow.HarnessError && error.type === "tool_permission_denied") {
            await input.toolReporter?.approval({
              name: "local_shell",
              label: input.context.toolPermissions?.getTool("local_shell")?.label,
              status: "rejected",
              requestId: readApprovalRequestId(error),
              message: error.message,
              arguments: readShellApprovalArguments(approvalItem),
              values: readApprovalValues(error),
            });
            return { approve: false, reason: error.message };
          }
          throw error;
        }
      },
    }),
  ];
}

function isOpenAIAgentsToolEnabled(context: NodeRunContext, name: string): boolean {
  if (!OPENAI_AGENTS_TOOL_NAMES.includes(name)) {
    return false;
  }
  return context.toolPermissions?.getTool(name)?.enabled !== false;
}

async function approveOpenAIAgentsFunctionTool(
  context: NodeRunContext | undefined,
  toolName: string,
  args: unknown,
  options: { toolReporter?: OpenAIAgentsToolOutputReporter } = {},
): Promise<void> {
  const registeredName = OPENAI_AGENTS_TOOL_NAMES.includes(toolName) ? toolName : "custom_tools";
  await approveOpenAIAgentsTool(context, registeredName, {
    toolName,
    arguments: args,
  }, options);
}

async function approveOpenAIAgentsHostedToolForRun(
  context: NodeRunContext | undefined,
  name: string,
  options: { toolReporter?: OpenAIAgentsToolOutputReporter } = {},
): Promise<void> {
  if (context === undefined) {
    return;
  }
  const tool = context.toolPermissions?.getTool(name);
  if (tool === undefined || !tool.enabled || tool.autoApprove) {
    return;
  }
  // Hosted OpenAI tools do not expose a local pre-call approval hook.
  // Ask once before the SDK run starts so manual approval still uses the shared
  // steamharness user-input node instead of silently hiding the tool.
  const decision = await toolApproval.approve({
    name,
    label: tool.label,
    description: tool.description,
    reason: `OpenAI hosted tool "${name}" may be used during this agent run.`,
    arguments: { scope: "run" },
  }, context as never);
  if (decision.requestId !== undefined) {
    await options.toolReporter?.approval({
      name,
      label: tool.label,
      status: "approved",
      requestId: decision.requestId,
      reason: `OpenAI hosted tool "${name}" may be used during this agent run.`,
      arguments: { scope: "run" },
      values: decision.values,
    });
  }
}

async function approveOpenAIAgentsTool(
  context: NodeRunContext | undefined,
  name: string,
  args: unknown,
  options: { toolReporter?: OpenAIAgentsToolOutputReporter } = {},
): Promise<void> {
  if (context === undefined) {
    return;
  }
  const tool = context.toolPermissions?.getTool(name);
  if (tool === undefined) {
    return;
  }
  // keeps OpenAI Agents function and shell calls behind the shared
  // steamharness approval gate while preserving the existing SDK output cards.
  const decision = await toolApproval.approve({
    name,
    label: tool?.label,
    description: tool?.description,
    arguments: args,
  }, context as never);
  if (decision.requestId !== undefined) {
    await options.toolReporter?.approval({
      name,
      label: tool?.label,
      status: "approved",
      requestId: decision.requestId,
      arguments: args,
      values: decision.values,
    });
  }
}

function readShellApprovalArguments(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (isRecord(value.rawItem)) {
    return value.rawItem;
  }
  if (isRecord(value.item)) {
    return value.item;
  }
  return value;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function normalizeInstructions(value: unknown): string[] {
  if (typeof value === "string") {
    const instruction = normalizeOptionalString(value);
    return instruction === undefined ? [] : [instruction];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const instruction = normalizeOptionalString(item);
    return instruction === undefined ? [] : [instruction];
  });
}

function createConversationSnapshot(state: {
  conversationId?: string;
  messages: Array<{ role: string; content: string }>;
}): ConversationSnapshot {
  return {
    conversationId: state.conversationId,
    messages: state.messages.slice(-6).map((message): ConversationMessageSnapshot => ({
      role: message.role,
      content: truncateText(message.content, 500),
    })),
  };
}

function createConversationTitle(input: OpenAIAgentsRunInput, conversation: ConversationSnapshot): string {
  const firstUserMessage = conversation.messages.find((message) => message.role === "user")?.content;
  return truncateText(firstUserMessage ?? input.message, 48);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function readAgentFacts(value: unknown): AgentFact[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    const key = normalizeOptionalString(item.key);
    const factValue = normalizeOptionalString(item.value);
    const updatedAt = normalizeOptionalString(item.updatedAt);
    if (key === undefined || factValue === undefined || updatedAt === undefined) {
      return [];
    }

    return [{ key, value: factValue, updatedAt }];
  });
}

function upsertFact(facts: AgentFact[], fact: AgentFact): AgentFact {
  const index = facts.findIndex((item) => item.key === fact.key);
  if (index >= 0) {
    facts[index] = fact;
  } else {
    facts.push(fact);
  }
  return fact;
}

function summarizeAgentContext(context: {
  projectName: string;
  conversationId?: string;
  messages: ConversationMessageSnapshot[];
  runCount: number;
  message: string;
  workdir: string;
  facts: AgentFact[];
}) {
  return {
    projectName: context.projectName,
    conversationId: context.conversationId,
    recentMessages: context.messages,
    runCount: context.runCount,
    currentMessage: context.message,
    workdir: context.workdir,
    facts: context.facts,
  };
}

function readAgentUsage(value: unknown): AgentRunUsage {
  if (!isRecord(value)) {
    return {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    };
  }

  const inputTokenDetails = readRecordProperty(value, "inputTokenDetails", "input_token_details");

  return {
    requests: readFiniteNumber(value.requests),
    inputTokens: readNumberAlias(value, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]) ?? 0,
    outputTokens: readNumberAlias(value, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]) ?? 0,
    totalTokens: readNumberAlias(value, ["totalTokens", "total_tokens"]) ?? 0,
    cachedInputTokens: readNumberAlias(value, [
      "cachedInputTokens",
      "cached_input_tokens",
      "cachedPromptTokens",
      "cached_prompt_tokens",
      "cache_read_input_tokens",
    ]) ?? readNumberAlias(inputTokenDetails, [
      "cacheReadTokens",
      "cache_read_tokens",
      "cachedInputTokens",
      "cached_input_tokens",
    ]) ?? 0,
    cacheCreationTokens: readNumberAlias(value, [
      "cacheCreationTokens",
      "cache_creation_tokens",
      "cache_creation_input_tokens",
      "cacheWriteTokens",
      "cache_write_tokens",
    ]) ?? readNumberAlias(inputTokenDetails, [
      "cacheWriteTokens",
      "cache_write_tokens",
      "cacheCreationTokens",
      "cache_creation_tokens",
    ]) ?? 0,
  };
}

function readRunContextUsage(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.runContext)) {
    return undefined;
  }

  return value.runContext.usage;
}

function readToolCalls(items: unknown[]): AgentToolCallSummary[] {
  const calls: AgentToolCallSummary[] = [];

  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const rawItem = isRecord(item.rawItem) ? item.rawItem : undefined;
    if (rawItem?.type === "function_call") {
      calls.push({
        name: normalizeOptionalString(rawItem.name) ?? "function_call",
        status: normalizeOptionalString(rawItem.status),
      });
    } else if (rawItem?.type === "shell_call") {
      calls.push({
        name: "local_shell",
        status: normalizeOptionalString(rawItem.status),
      });
    }
  }

  return calls;
}

function mergeToolCalls(
  explicit: AgentToolCallSummary[],
  detected: AgentToolCallSummary[],
): AgentToolCallSummary[] {
  if (detected.length === 0) {
    return explicit;
  }

  const keys = new Set(explicit.map((item) => `${item.name}:${item.status ?? ""}`));
  return [
    ...explicit,
    ...detected.filter((item) => !keys.has(`${item.name}:${item.status ?? ""}`)),
  ];
}

function readFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readNumberAlias(
  value: Record<string, unknown> | undefined,
  aliases: string[],
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  for (const alias of aliases) {
    const item = value[alias];
    if (typeof item === "number" && Number.isFinite(item)) {
      return item;
    }
  }

  return undefined;
}

function readRecordProperty(
  value: Record<string, unknown>,
  ...aliases: string[]
): Record<string, unknown> | undefined {
  for (const alias of aliases) {
    const item = value[alias];
    if (isRecord(item)) {
      return item;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
