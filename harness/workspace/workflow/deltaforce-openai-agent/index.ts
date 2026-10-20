import { tool, type FunctionTool } from "@openai/agents";
import { z } from "zod";
import { openaiAgentsProject } from "@steamharness/openai-agents-workflow";
import type { AgentToolCallSummary, OpenAIAgentsInput, OpenAIAgentsOutputPayload } from "@steamharness/openai-agents-workflow/interface";
import { createFinalAnswerInput, parseReactThought } from "@steamharness/deltafore-agent-workflow/agent/decision";
import { clampRoundCount, DEFAULT_QUERY, parseInputArgs } from "@steamharness/deltafore-agent-workflow/agent/input";
import { createAttributePromptGuide } from "@steamharness/deltafore-agent-workflow/tools/attribute-labels";
import type {
  AgentToolResult,
  ConversationChatMessage,
  DeltaforceOpenAIAgentInput,
  DeltaforceOpenAIAgentOutputPayload,
  DeltaforceOpenAIParsedInput,
  FinalAnswerInput,
  NodeRunContext,
  RunPayload,
} from "./interface";
import {
  type DeltaforeApiConfig,
  type DeltaforeToolDefinition,
  type DeltaforeToolParameter,
  createDeltaforeApiConfig,
  createToolCatalog,
  DEFAULT_OPENAPI_URL,
} from "@steamharness/deltafore-agent-workflow/tools/openapi";
import { runTool } from "@steamharness/deltafore-agent-workflow/tools/runner";
import { isRecord } from "@steamharness/deltafore-agent-workflow/tools/values";

const DEFAULT_MODEL = "gpt-5.4";

interface DeltaforceOpenAIAgentRunInput extends RunPayload {
  parsed: DeltaforceOpenAIParsedInput;
  config: DeltaforeApiConfig;
  configModel?: string;
  mockAgentRunner?: boolean;
  history: ConversationChatMessage[];
  context: DeltaforceOpenAIAgentContext;
  __agentOutput?: OpenAIAgentsOutputPayload;
  __finalInput?: FinalAnswerInput;
}

interface DeltaforceOpenAIAgentRunResult {
  agentOutput: OpenAIAgentsOutputPayload;
  finalInput: FinalAnswerInput;
}

interface DeltaforceOpenAIAgentContext extends NodeRunContext {
  metadata?: NodeRunContext["metadata"] & {
    openaiModel?: string;
    mockAgentRunner?: boolean;
  };
}

type DeltaforceOutputChunk = RunOutputStreamChunk;

const inputNode = steamharness.createInputNode<DeltaforceOpenAIAgentInput, DeltaforceOpenAIParsedInput>({
  name: "deltaforce-openai-agent-input",
  parse(input) {
    const query = input.query.trim() || DEFAULT_QUERY;

    return {
      errCode: 0,
      errMessage: "",
      query,
      maxRounds: clampRoundCount(input.maxRounds),
      agentRunner: input.agentRunner,
    };
  },
});

const outputNode = steamharness.createOutputNode<DeltaforceOpenAIAgentRunInput, DeltaforceOpenAIAgentOutputPayload>({
  name: "deltaforce-openai-agent-output",
  async *stream(input) {
    const queue = createAsyncEventQueue<DeltaforceOutputChunk>();
    const runPromise = runDeltaforceOpenAIAgents(input, {
      onOutputChunk(chunk) {
        const normalized = normalizeChildOutputChunk(chunk);
        if (normalized !== undefined) {
          queue.push(normalized);
        }
      },
      onOutput(output) {
        for (const chunk of createOutputChunksFromPayload(output)) {
          queue.push(chunk);
        }
      },
    }).then(
      (result) => {
        input.__agentOutput = result.agentOutput;
        input.__finalInput = result.finalInput;
        queue.end();
      },
      (error) => {
        queue.fail(error);
      },
    );

    yield* queue;
    await runPromise;
  },
  async format(stream, input, context: NodeRunContext) {
    const finalInput = requireFinalInput(input);
    const agentOutput = requireAgentOutput(input);
    const answer = finalInput.content.trim();
    const toolSummary = finalInput.toolResults.length > 0
      ? finalInput.toolResults.map((result) => `${result.toolName}(${JSON.stringify(result.args)}): ${result.ok ? "ok" : "failed"}`).join("; ")
      : undefined;

    await context.conversation?.appendMessage({
      role: "user",
      content: finalInput.query,
      metadata: { timestamp: new Date().toISOString() },
    });
    await context.conversation?.appendMessage({
      role: "assistant",
      content: answer,
      metadata: {
        timestamp: new Date().toISOString(),
        toolCalls: toolSummary,
        confidence: finalInput.confidence,
      },
    });

    return {
      ...steamharness.createOutputPayload({
        errCode: finalInput.errCode,
        errMessage: finalInput.errMessage,
        items: stream.items.length > 0
          ? stream.items
          : agentOutput.items.length > 0
            ? agentOutput.items
            : [
                {
                  id: "deltaforce-openai-agent-fallback",
                  title: "Output",
                  content: answer,
                  contentType: "markdown",
                  collapsed: false,
                },
              ],
      }),
      success: finalInput.success,
      query: finalInput.query,
      rounds: finalInput.rounds,
      toolCallCount: finalInput.toolResults.length,
      conversationId: context.conversation?.conversationId,
      historyLength: finalInput.history.length + 2,
      confidence: finalInput.confidence,
      usedObjectIDs: finalInput.usedObjectIDs,
    };
  },
});

export const deltaforceOpenAIAgentProject = steamharness.defineProject<DeltaforceOpenAIAgentInput, DeltaforceOpenAIAgentOutputPayload>({
  name: "deltaforce-openai-agent",
  async run(input, context) {
    const parsed = await steamharness.runNode(inputNode, input, context);
    const projectContext = context as DeltaforceOpenAIAgentContext;
    await projectContext.conversation?.setTitle(createConversationTitle(parsed.query));
    const conversationState = await projectContext.conversation?.getValue();
    const history = createHistoryMessages(conversationState?.messages ?? []);
    const config = readDeltaforeApiConfig(projectContext);
    const output = await steamharness.runStreamNode(
      outputNode,
      {
        errCode: 0,
        errMessage: "",
        parsed,
        config,
        configModel: projectContext.metadata?.openaiModel,
        mockAgentRunner: projectContext.metadata?.mockAgentRunner,
        history,
        context: projectContext,
      },
      context,
    );

    return requireOutput(output.output);
  },
});

export const executor = steamharness.defineExecutor<DeltaforceOpenAIAgentInput, DeltaforceOpenAIAgentOutputPayload>({
  projectType: "conversation",
  workflow: deltaforceOpenAIAgentProject,
  tokenUsage: {
    enabled: true,
    display: true,
  },
  registry: [
    { name: "deltaforce-openai-input", node: inputNode },
    { name: "answer", node: outputNode, stream: true },
  ],
  params: [
    {
      kind: "auxiliary",
      id: "advanced",
      label: "Advanced",
      fields: [
        {
          name: "maxRounds",
          flag: "--max-rounds",
          type: "number",
          required: false,
          description: "OpenAI Agents SDK 最大轮数提示。",
          defaultValue: "10",
        }
      ],
    },
  ],
  createInput({ args }) {
    const defaults = steamharness.parseConversationDefaultInputArgs(args);
    return parseInputArgs(args, { message: defaults.message });
  },
  async createContext({ config: configuration, abortSignal }) {
    const config = configuration as Record<string, string | undefined>;
    const deltaforeApi = await createDeltaforeApiConfig({
      baseUrl: config.DELTAFORE_API_BASE_URL,
      openApiUrl: config.DELTAFORE_OPENAPI_URL ?? DEFAULT_OPENAPI_URL,
      signal: abortSignal,
    });

    return {
      metadata: {
        deltaforeApi,
        openaiModel: normalizeOptionalString(config.OPENAI_MODEL) ?? normalizeOptionalString(config.LLM_MODEL),
        mockAgentRunner: config.DELTAFORCE_OPENAI_AGENT_MOCK === "1",
      },
    };
  },
});

export { deltaforceOpenAIAgentProject as workflow };
export default deltaforceOpenAIAgentProject;

export function createDeltaforceTools(input: {
  config: DeltaforeApiConfig;
  context: DeltaforceOpenAIAgentContext;
  toolResults: AgentToolResult[];
  toolEvents: AgentToolCallSummary[];
}): Array<FunctionTool<unknown, z.ZodObject<Record<string, z.ZodTypeAny>>, AgentToolResult>> {
  return input.config.tools.map((definition) => {
    const parameters = createToolParameters(definition);

    return tool<typeof parameters, unknown, AgentToolResult>({
      name: definition.toolName,
      description: createToolDescription(definition),
      parameters,
      async execute(args) {
        const normalizedArgs = normalizeToolArgs(args);
        const result = await runTool(
          input.config,
          {
            toolName: definition.toolName,
            args: normalizedArgs,
          },
          {
            signal: input.context.abortSignal,
          },
        );
        input.toolResults.push(result);
        input.toolEvents.push({
          name: definition.toolName,
          status: result.ok ? "completed" : "failed",
        });
        return result;
      },
    });
  });
}

async function runDeltaforceOpenAIAgents(
  input: DeltaforceOpenAIAgentRunInput,
  handlers: {
    onOutputChunk(chunk: unknown): Promise<void> | void;
    onOutput(output: OpenAIAgentsOutputPayload): Promise<void> | void;
  },
): Promise<DeltaforceOpenAIAgentRunResult> {
  const toolResults: AgentToolResult[] = [];
  const toolEvents: AgentToolCallSummary[] = [];
  const customTools = createDeltaforceTools({
    config: input.config,
    context: input.context,
    toolResults,
    toolEvents,
  });
  const agentOutput = await steamharness.runProject(
    openaiAgentsProject,
    createOpenAIAgentsInput({
      parsed: input.parsed,
      config: input.config,
      configModel: input.configModel,
      mockAgentRunner: input.mockAgentRunner,
      history: input.history,
      customTools,
      toolEvents,
    }),
    input.context,
    {
      name: "OpenAI Agents core",
      conversationMode: "shared-readonly",
      kvMode: "isolated",
      outputVisibility: "hidden",
      metadata: {
        title: "OpenAI Agents core",
        type: "workflow",
      },
      onOutputChunk: handlers.onOutputChunk,
      onOutput: handlers.onOutput,
    },
  );
  const finalInput = createFinalInputFromAgentOutput({
    parsed: input.parsed,
    history: input.history,
    toolResults,
    agentOutputText: readAgentOutputText(agentOutput),
  });

  return {
    agentOutput,
    finalInput,
  };
}

function createOpenAIAgentsInput(input: {
  parsed: DeltaforceOpenAIParsedInput;
  config: DeltaforeApiConfig;
  configModel?: string;
  mockAgentRunner?: boolean;
  history: ConversationChatMessage[];
  customTools: unknown[];
  toolEvents: AgentToolCallSummary[];
}): OpenAIAgentsInput {
  return {
    message: input.parsed.query,
    model: input.configModel ?? DEFAULT_MODEL,
    workdir: ".",
    localShell: false,
    agentName: "deltaforce-openai-agent",
    instructions: [
      createDeltaforceAgentsSystemPrompt(input.config),
      createDeltaforceOpenAIAgentPrompt(input.parsed, input.history),
    ],
    defaultTools: false,
    memoryTools: false,
    testTool: false,
    writeConversation: false,
    writeAgentState: false,
    customTools: input.customTools,
    agentRunner: input.parsed.agentRunner ?? createFixtureAgentRunner(input.mockAgentRunner, input.toolEvents),
  };
}

function createFixtureAgentRunner(mockAgentRunner: boolean | undefined, toolEvents: AgentToolCallSummary[]) {
  if (mockAgentRunner !== true) {
    return undefined;
  }

  return async ({ tools }: { tools: unknown[] }) => {
    const gunsTool = tools.find((candidate): candidate is FunctionTool<unknown> =>
      isRecord(candidate) && candidate.type === "function" && candidate.name === "get_api_guns",
    );
    if (gunsTool === undefined) {
      return {
        finalOutput: "未找到 get_api_guns 工具。",
        history: [],
        newItems: [],
        usage: {
          requests: 1,
          inputTokens: 24,
          outputTokens: 16,
          totalTokens: 40,
          cachedInputTokens: 6,
          cacheCreationTokens: 8,
        },
      };
    }

    const output = await gunsTool.invoke(
      { context: {} } as Parameters<typeof gunsTool.invoke>[0],
      JSON.stringify({ q: "M7", limit: 3 }),
    );
    const summary = isRecord(output) && typeof output.summary === "string" ? output.summary : "tool completed";
    toolEvents.push({ name: "get_api_guns", status: "completed" });

    return {
      finalOutput: [
        "**离线 mock 推荐**",
        "",
        "- 武器：M7 战斗步枪",
        `- 工具结果：${summary}`,
        "- 建议：优先稳定后坐力，再补操控速度。",
      ].join("\n"),
      history: [{ role: "user" }, { role: "assistant" }],
      newItems: [
        {
          rawItem: {
            type: "function_call",
            name: "get_api_guns",
            status: "completed",
          },
        },
      ],
      usage: {
        requests: 1,
        inputTokens: 24,
        outputTokens: 16,
        totalTokens: 40,
        cachedInputTokens: 6,
        cacheCreationTokens: 8,
      },
    };
  };
}

function createToolParameters(
  definition: DeltaforeToolDefinition,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const parameter of definition.parameters) {
    shape[parameter.name] = createParameterSchema(parameter);
  }

  return z.object(shape);
}

function createParameterSchema(parameter: DeltaforeToolParameter): z.ZodTypeAny {
  let schema: z.ZodTypeAny;

  if (parameter.enum?.length) {
    schema = z.enum(parameter.enum as [string, ...string[]]);
  } else if (parameter.type === "integer") {
    schema = z.number().int();
  } else if (parameter.type === "number") {
    schema = z.number();
  } else if (parameter.type === "boolean") {
    schema = z.boolean();
  } else {
    schema = z.string();
  }

  if (parameter.minimum !== undefined && "min" in schema && typeof schema.min === "function") {
    schema = schema.min(parameter.minimum);
  }
  if (parameter.maximum !== undefined && "max" in schema && typeof schema.max === "function") {
    schema = schema.max(parameter.maximum);
  }

  return parameter.required ? schema : schema.optional();
}

function createToolDescription(definition: DeltaforeToolDefinition): string {
  const parameters = definition.parameters.map((parameter) => {
    const required = parameter.required ? "required" : "optional";
    const type = parameter.enum?.length ? parameter.enum.join("|") : parameter.type ?? "string";
    return `${parameter.name} (${parameter.in}, ${required}, ${type})`;
  }).join("; ");

  return [
    `${definition.method} ${definition.path}`,
    definition.summary,
    definition.description,
    parameters ? `Parameters: ${parameters}` : undefined,
  ].filter((part): part is string => part !== undefined && part.trim() !== "").join("\n");
}

function createDeltaforceOpenAIAgentPrompt(
  parsed: DeltaforceOpenAIParsedInput,
  history: ConversationChatMessage[],
): string {
  return [
    `用户需求：${parsed.query}`,
    `最大工具轮次提示：${parsed.maxRounds}`,
    "本次只能通过已注册的 Delta Force OpenAPI function tools 查询数据。",
    "不要把工具调用写成 JSON 文本；需要查数据时必须直接调用对应 function tool。",
    "最终回复直接输出面向用户的中文 Markdown 文本，不要输出 ReAct JSON、phase、action、finalAnswer 包装字段或代码块。",
    "如果需要确认 M7，请优先直接调用 get_api_guns，参数 q=\"M7\", limit=3。",
    "",
    "父级会话历史快照：",
    history.length === 0 ? "暂无。" : history.map((message) => `${message.role}: ${message.content}`).join("\n"),
  ].join("\n");
}

function createDeltaforceAgentsSystemPrompt(config: DeltaforeApiConfig): string {
  return [
    "你是三角洲行动数据 Agent，负责基于线上数据库 API 回答装备、配装、价格、地图、干员、据点生产、同步状态等问题。",
    "所有事实必须来自已注册的 Delta Force function tools 返回的真实 HTTP 数据；配置判断、取舍、推荐和解释由你自己完成。",
    "需要查数据时，直接调用 function tool，不要把工具名和参数写成 JSON 文本给用户看。",
    "最终回答必须是自然中文 Markdown 文本，禁止输出 ReAct JSON、phase、action、thought、finalAnswer 等协议字段。",
    "如果接口返回为空或字段不足，要明确说明不确定，不要编造不存在的装备、字段、价格、接口或数值。",
    "最终回答和过程说明都尽量使用中文属性名，例如把 controlSpeed 写成操控速度，把 primaryClass 写成一级分类。",
    "工具返回里的 data.preview / uiPreview 只是界面预览，可能被裁剪；推理优先读取 data.agentFacts。",
    "只有当 agentFacts.page.hasMore 为 true 时，才说明 API 分页还有更多数据，并用 agentFacts.nextPageArgs 继续调用同一个工具补下一页。",
    "POST /api/sync/* 是维护/同步工具，可能改变服务端数据库；只有用户明确要求同步、刷新或排查同步时才允许调用。",
    "",
    "常见属性字典：",
    createAttributePromptGuide(),
    "",
    "固定配置字典：",
    config.objectConfigPrompt,
    "",
    "工具目录：",
    createToolCatalog(config),
  ].join("\n");
}

function createFinalInputFromAgentOutput(input: {
  parsed: DeltaforceOpenAIParsedInput;
  history: ConversationChatMessage[];
  toolResults: AgentToolResult[];
  agentOutputText: string;
}): FinalAnswerInput {
  const finalThought = parseAgentFinalOutput(input.agentOutputText);
  const finalAnswer = finalThought.finalAnswer ?? finalThought.rawText;

  return createFinalAnswerInput(
    input.parsed,
    {
      ...finalThought,
      errCode: finalAnswer.trim() === "" ? 1 : finalThought.errCode,
      errMessage: finalAnswer.trim() === "" ? "OpenAI Agents workflow did not produce output." : finalThought.errMessage,
      finalAnswer: finalAnswer.trim() || "OpenAI Agents workflow did not produce output.",
      confidence: finalThought.confidence ?? (input.toolResults.length > 0 && input.toolResults.every((result) => result.ok) ? "high" : "medium"),
      usedObjectIDs: finalThought.usedObjectIDs?.length ? finalThought.usedObjectIDs : collectObjectIds(input.toolResults),
    },
    createObservedSteps(input.toolResults),
    input.history,
  );
}

function parseAgentFinalOutput(text: string) {
  const parsed = parseReactThought(text);
  if (parsed.phase === "action") {
    return {
      errCode: 1,
      errMessage: "OpenAI Agents workflow returned a tool-call JSON object instead of a final answer.",
      phase: "final_answer" as const,
      rawText: text,
      thought: parsed.thought,
      finalAnswer: parsed.thought.summary,
      confidence: "low" as const,
      usedObjectIDs: [],
    };
  }

  return parsed;
}

function createObservedSteps(toolResults: AgentToolResult[]) {
  return toolResults.map((result, index) => ({
    round: index + 1,
    thought: {
      summary: `OpenAI Agents SDK 调用了 ${result.toolName}。`,
    },
    action: {
      toolName: result.toolName,
      args: result.args,
    },
    observation: result.summary,
    toolResult: result,
    status: result.ok ? "observed" as const : "failed" as const,
  }));
}

function readAgentOutputText(output: OpenAIAgentsOutputPayload): string {
  const answerItem = output.items.find((item) => item.id === "openai-agents-answer");
  if (typeof answerItem?.content === "string" && answerItem.content.trim() !== "") {
    return answerItem.content.trim();
  }

  return output.items
    .filter((item) => item.metadata?.kind !== "openai-agents-tool-call")
    .map((item) => typeof item.content === "string" ? item.content : "")
    .join("\n")
    .trim();
}

function normalizeChildOutputChunk(chunk: unknown): DeltaforceOutputChunk | undefined {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (isOutputItemChunk(chunk)) {
    return chunk;
  }

  if (chunk === undefined || chunk === null) {
    return undefined;
  }

  return formatFallbackOutputValue(chunk);
}

function createOutputChunksFromPayload(output: OpenAIAgentsOutputPayload): DeltaforceOutputChunk[] {
  if (!Array.isArray(output.items) || output.items.length === 0) {
    return [formatFallbackOutputValue(output)];
  }

  return output.items.flatMap((item, index) => {
    if (!isRecord(item)) {
      return [formatFallbackOutputValue(item)];
    }

    const id = typeof item.id === "string" && item.id.trim() !== ""
      ? item.id
      : `nested-workflow-output-${index + 1}`;
    return [
      steamharness.createOutputItemChunk({
        type: "output_item_start",
        item: {
          id,
          title: typeof item.title === "string" ? item.title : "Output",
          content: "",
          icon: typeof item.icon === "string" ? item.icon : undefined,
          iconPreset: typeof item.iconPreset === "string" ? item.iconPreset : undefined,
          contentType: item.contentType === "json" || item.contentType === "text" || item.contentType === "markdown"
            ? item.contentType
            : inferOutputContentType(item.content),
          collapsed: typeof item.collapsed === "boolean" ? item.collapsed : undefined,
          metadata: isRecord(item.metadata) ? item.metadata : undefined,
        },
      }),
      steamharness.createOutputItemChunk({
        type: "output_item_delta",
        itemId: id,
        delta: item.content ?? "",
      }),
      steamharness.createOutputItemChunk({
        type: "output_item_end",
        itemId: id,
      }),
    ];
  });
}

function isOutputItemChunk(value: unknown): value is OutputItemChunk {
  return isRecord(value) &&
    (
      value.type === "output_item_start" ||
      value.type === "output_item_delta" ||
      value.type === "output_item_end"
    );
}

function inferOutputContentType(value: unknown): "markdown" | "json" {
  return typeof value === "object" && value !== null ? "json" : "markdown";
}

function formatFallbackOutputValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function createAsyncEventQueue<T>(): AsyncIterable<T> & {
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
} {
  const values: T[] = [];
  const waiters: Array<{
    resolve(result: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  let ended = false;
  let failed: unknown;

  return {
    push(value: T) {
      if (ended || failed !== undefined) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter.resolve({ value, done: false });
        return;
      }
      values.push(value);
    },
    end() {
      ended = true;
      while (waiters.length > 0) {
        waiters.shift()?.resolve({ value: undefined, done: true });
      }
    },
    fail(error: unknown) {
      failed = error;
      while (waiters.length > 0) {
        waiters.shift()?.reject(error);
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          const value = values.shift();
          if (value !== undefined) {
            return Promise.resolve({ value, done: false });
          }
          if (failed !== undefined) {
            return Promise.reject(failed);
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
      };
    },
  };
}

function requireOutput(output: DeltaforceOpenAIAgentOutputPayload | undefined): DeltaforceOpenAIAgentOutputPayload {
  if (output === undefined) {
    throw new Error("Deltaforce OpenAI agent output node did not return a payload.");
  }

  return output;
}

function requireFinalInput(input: DeltaforceOpenAIAgentRunInput): FinalAnswerInput {
  if (input.__finalInput === undefined) {
    throw new Error("Deltaforce OpenAI agent finished without a final answer.");
  }

  return input.__finalInput;
}

function requireAgentOutput(input: DeltaforceOpenAIAgentRunInput): OpenAIAgentsOutputPayload {
  if (input.__agentOutput === undefined) {
    throw new Error("Deltaforce OpenAI agent finished without nested workflow output.");
  }

  return input.__agentOutput;
}

function collectObjectIds(toolResults: AgentToolResult[]): Array<number | string> {
  const ids = new Set<number | string>();

  for (const result of toolResults) {
    collectObjectIdsFromValue(result.data, ids);
  }

  return [...ids].slice(0, 20);
}

function collectObjectIdsFromValue(value: unknown, ids: Set<number | string>): void {
  if (ids.size >= 20) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectObjectIdsFromValue(item, ids);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const objectId = value.objectId ?? value.objectID;
  if (typeof objectId === "number" || typeof objectId === "string") {
    ids.add(objectId);
  }
  for (const nested of Object.values(value)) {
    collectObjectIdsFromValue(nested, ids);
  }
}

function createConversationTitle(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (normalized === "") return "Deltaforce OpenAI agent";
  const prefix = "Deltaforce: ";
  const budget = 48 - prefix.length;
  return normalized.length <= budget ? `${prefix}${normalized}` : `${prefix}${normalized.slice(0, budget - 1)}...`;
}

function createHistoryMessages(
  messages: Array<{
    role: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>,
): ConversationChatMessage[] {
  return messages
    .filter((message): message is { role: "user" | "assistant"; content: string; metadata?: Record<string, unknown> } =>
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string" &&
      message.content.trim() !== "",
    )
    .map((message) => ({
      role: message.role,
      content: message.content,
      metadata: message.metadata ? {
        timestamp: typeof message.metadata.timestamp === "string" ? message.metadata.timestamp : undefined,
        toolCalls: typeof message.metadata.toolCalls === "string" ? message.metadata.toolCalls : undefined,
        confidence: typeof message.metadata.confidence === "string" ? message.metadata.confidence : undefined,
      } : undefined,
    }));
}

function readDeltaforeApiConfig(context: NodeRunContext): DeltaforeApiConfig {
  const config = context.metadata?.deltaforeApi;

  if (isDeltaforeApiConfig(config)) {
    return config;
  }

  throw new Error("Delta Force API config is not available in workflow context.");
}

function isDeltaforeApiConfig(value: unknown): value is DeltaforeApiConfig {
  return isRecord(value) &&
    typeof value.baseUrl === "string" &&
    typeof value.openApiUrl === "string" &&
    typeof value.objectConfigUrl === "string" &&
    typeof value.objectConfigPrompt === "string" &&
    Array.isArray(value.tools);
}

function normalizeToolArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
