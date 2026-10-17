import type {
  CompactedHistory,
  ConversationChatMessage,
  DeltaforeAgentInput,
  DeltaforeAgentOutputPayload,
  ReactLoopState,
  ReactThoughtPayload,
  WorkflowNodeContext,
} from "./interface";
import {
  createCompactedHistorySummary,
  shouldCompactHistory,
} from "./agent/context";
import { createFallbackThought, createFinalAnswerInput } from "./agent/decision";
import { DEFAULT_QUERY, parseInputArgs } from "./agent/input";
import { createObservation } from "./agent/tool-details";
import {
  agentDecisionNode,
  answerOutputNode,
  inputNode,
  thoughtOutputNode,
  toolNode,
} from "./nodes/nodes";
import { createDeltaforeApiConfig, DEFAULT_OPENAPI_URL } from "./tools/openapi";

export const deltaforeAgentWorkflow = workflow.defineWorkflow<DeltaforeAgentInput, DeltaforeAgentOutputPayload>({
  name: "deltafore-agent",
  async run(input, context) {
    const parsed = await workflow.runNode(inputNode, input, context);
    const conversationContext = context as WorkflowNodeContext;
    await conversationContext.conversation?.setTitle(createConversationTitle(parsed.query));
    const conversationState = await conversationContext.conversation?.getValue();
    const history = createHistoryMessages(conversationState?.messages ?? []);

    const compactedHistory = await readCompactedHistory(context);

    const seed: ReactLoopState = {
      errCode: 0,
      errMessage: "",
      phase: "thinking",
      query: parsed.query,
      maxRounds: parsed.maxRounds,
      round: 0,
      history,
      steps: [],
      compactedHistory,
      usedObjectIDs: [],
    };

    const loopState = await workflow.runWhile(seed, context, {
      name: "ReAct loop",
      maxIterations: parsed.maxRounds,
      condition: (state) => state.phase === "thinking",
      async run(state, loopContext, iteration) {
        const round = iteration + 1;

        const thought = await workflow.runNode(
          agentDecisionNode,
          { errCode: 0, errMessage: "", query: state.query, maxRounds: state.maxRounds, round, history: state.history, steps: state.steps, compactedHistory: state.compactedHistory },
          loopContext,
        );

        if (thought.phase === "final_answer") {
          return {
            ...state,
            round,
            phase: "done" as const,
            finalAnswer: thought.finalAnswer,
            confidence: thought.confidence,
            usedObjectIDs: thought.usedObjectIDs ?? [],
          };
        }

        if (thought.action === undefined) {
          return {
            ...state,
            round,
            phase: "done" as const,
            finalAnswer: createFallbackThought(
              "LLM requested an Action but did not provide a valid action object.",
              { errCode: 0, errMessage: "", query: state.query, maxRounds: state.maxRounds, round, history: state.history, steps: state.steps },
            ).finalAnswer,
            confidence: "low",
            usedObjectIDs: [],
          };
        }

        await workflow.runStreamNode(
          thoughtOutputNode,
          { errCode: 0, errMessage: "", round, thought: thought.thought, action: thought.action },
          loopContext,
        );

        const toolPayload = await workflow.runStreamNode(
          toolNode,
          { errCode: 0, errMessage: "", round, toolCall: thought.action },
          loopContext,
        );
        const toolOutput = requireToolOutput(toolPayload.output);
        const observation = createObservation(toolOutput.result);
        const observedStep = {
          round,
          thought: thought.thought,
          action: thought.action,
          observation,
          toolResult: toolOutput.result,
          status: toolOutput.result.ok ? "observed" as const : "failed" as const,
        };

        return {
          ...state,
          round,
          steps: [...state.steps, observedStep],
        };
      },
    });

    await writeCompactedHistory(context, loopState.history, loopState.compactedHistory);

    const finalThought: ReactThoughtPayload = loopState.finalAnswer !== undefined
      ? {
          errCode: 0,
          errMessage: "",
          phase: "final_answer",
          rawText: loopState.finalAnswer,
          thought: { summary: "基于已有观察给出最终回答。" },
          finalAnswer: loopState.finalAnswer,
          confidence: loopState.confidence,
          usedObjectIDs: loopState.usedObjectIDs,
        }
      : createFallbackThought(
          "达到最大循环轮数，无法继续查询。下面只基于已经查到的数据给出保守结论。",
          { errCode: 0, errMessage: "", query: loopState.query, maxRounds: loopState.maxRounds, round: loopState.round, history: loopState.history, steps: loopState.steps },
        );

    const output = await workflow.runStreamNode(
      answerOutputNode,
      createFinalAnswerInput(parsed, finalThought, loopState.steps, history),
      context,
    );

    return requireOutput(output.output);
  },
});

export const executor = workflow.defineExecutor<DeltaforeAgentInput, DeltaforeAgentOutputPayload>({
  projectType: "conversation",
  workflow: deltaforeAgentWorkflow,
  tokenUsage: {
    enabled: true,
    display: true,
  },
  registry: [
    { name: "react-thought", node: agentDecisionNode },
    { name: "thought-output", node: thoughtOutputNode, stream: true },
    { name: "equipment-tool", node: toolNode, stream: true },
    { name: "answer", node: answerOutputNode, stream: true },
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
          description: "ReAct loop 最大推理/行动轮数。",
          defaultValue: "10",
        }
      ],
    },
  ],
  createInput({ args }) {
    const defaults = workflow.parseConversationDefaultInputArgs(args);
    return parseInputArgs(args, { message: defaults.message });
  },
  async createContext({ env, abortSignal }) {
    const deltaforeApi = await createDeltaforeApiConfig({
      baseUrl: env.DELTAFORE_API_BASE_URL,
      openApiUrl: env.DELTAFORE_OPENAPI_URL ?? DEFAULT_OPENAPI_URL,
      signal: abortSignal,
    });

    return {
      metadata: {
        deltaforeApi,
      },
    };
  },
});

export { deltaforeAgentWorkflow as workflow };
export default deltaforeAgentWorkflow;

function requireOutput(output: DeltaforeAgentOutputPayload | undefined): DeltaforeAgentOutputPayload {
  if (output === undefined) {
    throw new Error("Output node did not produce output.");
  }

  return output;
}

function requireToolOutput(output: Awaited<ReturnType<typeof toolNode.finalize>> | undefined) {
  if (output === undefined) {
    throw new Error("Tool stream node did not produce output.");
  }

  return output;
}

function createConversationTitle(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (normalized === "") return "Deltafore agent";
  const prefix = "Deltafore: ";
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

async function readCompactedHistory(context: unknown): Promise<CompactedHistory | undefined> {
  try {
    const kv = (context as { kv?: { conversation?: { getValue(key: string): Promise<unknown> } } }).kv;
    const raw = await kv?.conversation?.getValue("context.compactedHistory");
    if (raw && typeof raw === "object" && "summary" in (raw as object)) {
      return raw as CompactedHistory;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeCompactedHistory(
  context: unknown,
  history: ConversationChatMessage[],
  existing: CompactedHistory | undefined,
): Promise<void> {
  try {
    if (!shouldCompactHistory(history.length, existing)) return;
    const kv = (context as { kv?: { conversation?: { setValue(key: string, value: unknown): Promise<void> } } }).kv;
    if (!kv?.conversation) return;
    const compacted = createCompactedHistorySummary(history, existing);
    await kv.conversation.setValue("context.compactedHistory", compacted);
  } catch {
    // KV write failure is non-fatal
  }
}
