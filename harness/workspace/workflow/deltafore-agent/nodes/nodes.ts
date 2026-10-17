import type {
  AgentDecisionInput,
  DeltaforeAgentInput,
  DeltaforeAgentOutputPayload,
  FinalAnswerInput,
  ParsedAgentInput,
  ThoughtOutputInput,
  ThoughtOutputPayload,
  ToolExecutionInput,
  ToolExecutionPayload,
  ReactThoughtPayload,
  WorkflowNodeContext,
} from "../interface";
import { parseReactThought } from "../agent/decision";
import { clampRoundCount, DEFAULT_QUERY } from "../agent/input";
import { createAgentPrompt, createSystemPrompt } from "../agent/prompts";
import {
  createObservation,
  createToolResultContent,
  createToolResultIcon,
  createToolResultTitle,
  createToolRunningContent,
  createToolRunningTitle,
} from "../agent/tool-details";
import type { DeltaforeApiConfig } from "../tools/openapi";
import { runTool } from "../tools/runner";

const llmProvider = workflow.createLLMProviderRef("default", () => {
  return workflow.createLLMProviderFromEnv();
});

export const inputNode = workflow.createInputNode<DeltaforeAgentInput, ParsedAgentInput>({
  name: "deltafore-agent-input",
  parse(input: DeltaforeAgentInput) {
    const query = input.query.trim() || DEFAULT_QUERY;

    return {
      errCode: 0,
      errMessage: "",
      query,
      maxRounds: clampRoundCount(input.maxRounds),
    };
  },
});

export const agentDecisionNode = workflow.createLLMNode<AgentDecisionInput, ReactThoughtPayload>({
  name: "react-thought-llm",
  provider: llmProvider,
  mapInput(input: AgentDecisionInput, context: WorkflowNodeContext) {
    const config = readDeltaforeApiConfig(context);

    return {
      system: createSystemPrompt(config),
      prompt: createAgentPrompt(input, config, input.compactedHistory),
      maxOutputTokens: 1600,
      temperature: 0.2,
      abortSignal: context.abortSignal,
    };
  },
  mapOutput(output: { text: string }) {
    return parseReactThought(output.text);
  },
});

export const thoughtOutputNode = workflow.createOutputNode<ThoughtOutputInput, ThoughtOutputPayload>({
  name: "react-thought-output",
  async *stream(input: ThoughtOutputInput) {
    const itemId = `thought-${input.round}`;
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: itemId,
        content: "",
        contentType: "markdown",
        collapsed: false,
        metadata: { kind: "thought", round: input.round },
      },
    });
    for (const chunk of streamChunks(input.thought.summary, 6)) {
      await tick();
      yield workflow.createOutputItemChunk({
        type: "output_item_delta",
        itemId,
        delta: chunk,
      });
    }
    yield workflow.createOutputItemChunk({ type: "output_item_end", itemId });
  },
  format(stream, input: ThoughtOutputInput) {
    return {
      ...workflow.createOutputPayload({ items: [] }),
      round: input.round,
    };
  },
});

export const toolNode = workflow.createOutputNode<ToolExecutionInput, ToolExecutionPayload>({
  name: "equipment-tool",
  async *stream(input: ToolExecutionInput, context: WorkflowNodeContext) {
    const config = readDeltaforeApiConfig(context);
    const itemId = createToolItemId(input);
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: itemId,
        title: createToolRunningTitle(input.toolCall, input.round),
        icon: "[i]",
        content: createToolRunningContent(input.toolCall, input.round),
        contentType: "json",
        collapsed: true,
        metadata: {
          kind: "tool-call",
          phase: "tool",
          round: input.round,
          toolName: input.toolCall.toolName,
          status: "running",
        },
      },
    });
    const result = await runTool(config, input.toolCall, {
      signal: context.abortSignal,
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_delta",
      itemId,
      delta: createToolResultContent(result),
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_delta",
      itemId,
      delta: {
        status: result.ok ? "success" : "failed",
      },
      item: {
        title: createToolResultTitle(result),
        icon: createToolResultIcon(result),
        metadata: {
          kind: "tool-call",
          phase: "tool",
          round: input.round,
          toolName: result.toolName,
          status: result.ok ? "success" : "failed",
          durationMs: result.durationMs,
        },
      },
    });
    yield workflow.createOutputItemChunk({
      type: "output_item_end",
      itemId,
    });
  },
  format(stream, input: ToolExecutionInput) {
    const result = readToolResult(stream.items[0]?.content, input.toolCall.toolName, input.toolCall.args);
    return {
      errCode: result.ok ? 0 : 1,
      errMessage: result.ok ? "" : result.summary,
      items: stream.items,
      result,
      phase: "tool",
      round: input.round,
      toolName: result.toolName,
      ok: result.ok,
    };
  },
});

export const answerOutputNode = workflow.createOutputNode<FinalAnswerInput, DeltaforeAgentOutputPayload>({
  name: "deltafore-agent-output",
  async *stream(input: FinalAnswerInput) {
    const itemId = `answer-${Date.now()}`;
    yield workflow.createOutputItemChunk({
      type: "output_item_start",
      item: {
        id: itemId,
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
      },
    });

    for (const chunk of streamChunks(input.content, 8)) {
      await tick();
      yield workflow.createOutputItemChunk({
        type: "output_item_delta",
        itemId,
        delta: chunk,
      });
    }

    yield workflow.createOutputItemChunk({ type: "output_item_end", itemId });
  },
  async format(stream, input: FinalAnswerInput, context: WorkflowNodeContext) {
    const answer = input.content.trim();
    const toolSummary = input.toolResults.length > 0
      ? input.toolResults.map((r) => `${r.toolName}(${JSON.stringify(r.args)}): ${r.ok ? "ok" : "failed"}`).join("; ")
      : undefined;

    await context.conversation?.appendMessage({
      role: "user",
      content: input.query,
      metadata: { timestamp: new Date().toISOString() },
    });
    await context.conversation?.appendMessage({
      role: "assistant",
      content: answer,
      metadata: {
        timestamp: new Date().toISOString(),
        toolCalls: toolSummary,
        confidence: input.confidence,
      },
    });

    return {
      ...workflow.createOutputPayload({
        errCode: input.errCode,
        errMessage: input.errMessage,
        items: stream.items,
      }),
      success: input.success,
      query: input.query,
      rounds: input.rounds,
      toolCallCount: input.toolResults.length,
      conversationId: context.conversation?.conversationId,
      historyLength: input.history.length + 2,
      confidence: input.confidence,
      usedObjectIDs: input.usedObjectIDs,
    };
  },
});

function createToolItemId(input: ToolExecutionInput): string {
  return `tool-${input.round}-${input.toolCall.toolName}`;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function streamChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function readDeltaforeApiConfig(context: WorkflowNodeContext): DeltaforeApiConfig {
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

function readToolResult(
  content: unknown,
  fallbackToolName: ToolExecutionInput["toolCall"]["toolName"],
  fallbackArgs: ToolExecutionInput["toolCall"]["args"],
): ToolExecutionPayload["result"] {
  if (isRecord(content)) {
    return {
      toolName: typeof content.tool === "string" ? content.tool as ToolExecutionPayload["result"]["toolName"] : fallbackToolName,
      args: isRecord(content.args) ? content.args : fallbackArgs,
      ok: content.ok === true,
      data: content.data,
      summary: typeof content.summary === "string" ? content.summary : "",
      startedAt: typeof content.startedAt === "string" ? content.startedAt : undefined,
      endedAt: typeof content.endedAt === "string" ? content.endedAt : undefined,
      durationMs: typeof content.durationMs === "number" ? content.durationMs : undefined,
    };
  }

  return {
    toolName: fallbackToolName,
    args: fallbackArgs,
    ok: false,
    data: null,
    summary: "Tool did not return a structured result.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
