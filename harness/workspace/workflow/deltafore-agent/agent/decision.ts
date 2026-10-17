import type {
  AgentDecisionInput,
  AgentToolCall,
  AgentToolName,
  AgentToolResult,
  FinalAnswerInput,
  ParsedAgentInput,
  ConversationChatMessage,
  ReactStep,
  ReactThought,
  ReactThoughtPayload,
} from "../interface";
import { isRecord, readOptionalString } from "../tools/values";

export function parseReactThought(text: string): ReactThoughtPayload {
  const rawText = text.trim();
  const data = parseJsonObject(rawText);
  const thought = readThought(data.thought ?? data.reasoning ?? data.analysis ?? data);
  const phase = readPhase(data.phase ?? data.decision ?? data.next);

  if (phase === "action") {
    const action = readToolCall(data.action ?? data.toolCall ?? data.tool_call);

    if (action === undefined) {
      return {
        errCode: 1,
        errMessage: "Invalid ReAct action.",
        phase: "action",
        rawText,
        thought,
      };
    }

    return {
      errCode: 0,
      errMessage: "",
      phase: "action",
      rawText,
      thought,
      action,
    };
  }

  const finalAnswer = readOptionalString(data.finalAnswer ?? data.final_answer ?? data.answer ?? data.content);

  return {
    errCode: finalAnswer === undefined ? 1 : 0,
    errMessage: finalAnswer === undefined ? "LLM did not provide finalAnswer." : "",
    phase: "final_answer",
    rawText,
    thought,
    finalAnswer: finalAnswer ?? rawText,
    confidence: readConfidence(data.confidence),
    usedObjectIDs: readObjectIDs(data.usedObjectIDs ?? data.used_object_ids),
  };
}

export function createFallbackThought(reason: string, state: AgentDecisionInput): ReactThoughtPayload {
  const summaries = getToolResultsFromSteps(state.steps).map((result) => result.summary).join("\n");

  return {
    errCode: 0,
    errMessage: "",
    phase: "final_answer",
    rawText: reason,
    thought: {
      summary: "当前 ReAct 循环已经无法继续得到有效动作。",
      evidenceGap: reason,
    },
    confidence: "low",
    usedObjectIDs: [],
    finalAnswer: [
      reason,
      summaries ? "" : undefined,
      summaries || undefined,
      "",
      "由于没有拿到可继续执行的 LLM 决策，这里不编造装备；请增加查询轮数或换一个更具体的需求后重试。",
    ].filter((line): line is string => line !== undefined).join("\n"),
  };
}

export function createFinalAnswerInput(
  parsed: ParsedAgentInput,
  thought: ReactThoughtPayload,
  steps: ReactStep[],
  history: ConversationChatMessage[] = [],
): FinalAnswerInput {
  const success = thought.errCode === 0 && thought.finalAnswer !== undefined;
  const toolResults = getToolResultsFromSteps(steps);

  return {
    errCode: success ? 0 : 1,
    errMessage: success ? "" : thought.errMessage || "Agent did not produce a final answer.",
    query: parsed.query,
    maxRounds: parsed.maxRounds,
    rounds: Math.min(parsed.maxRounds, Math.max(steps.length, toolResults.length + 1)),
    content: thought.finalAnswer ?? thought.rawText,
    success,
    history,
    confidence: thought.confidence,
    usedObjectIDs: thought.usedObjectIDs ?? [],
    toolResults,
  };
}

export function getToolResultsFromSteps(steps: ReactStep[]): AgentToolResult[] {
  return steps
    .map((step) => step.toolResult)
    .filter((result): result is AgentToolResult => result !== undefined);
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (isRecord(value)) {
      return value;
    }
  } catch {
    const jsonText = extractFirstJsonObject(text);
    if (jsonText !== undefined) {
      const value = JSON.parse(jsonText);
      if (isRecord(value)) {
        return value;
      }
    }
  }

  return {
    phase: "final_answer",
    finalAnswer: text,
    confidence: "low",
  };
}

function readPhase(value: unknown): ReactThoughtPayload["phase"] {
  const phase = readOptionalString(value);
  if (
    phase === "action" ||
    phase === "tool_call" ||
    phase === "toolCall" ||
    phase === "act"
  ) {
    return "action";
  }

  return "final_answer";
}

function readThought(value: unknown): ReactThought {
  if (typeof value === "string") {
    return {
      summary: value,
    };
  }

  if (isRecord(value)) {
    const summary = readOptionalString(value.summary ?? value.thought ?? value.publicThought ?? value.public_thought);
    return {
      summary: summary ?? "根据已有观察继续判断下一步。",
      hypothesis: readOptionalString(value.hypothesis ?? value.assumption),
      evidenceGap: readOptionalString(value.evidenceGap ?? value.evidence_gap ?? value.need),
      nextActionReason: readOptionalString(value.nextActionReason ?? value.next_action_reason ?? value.reason),
    };
  }

  return {
    summary: "根据已有观察继续判断下一步。",
  };
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function readToolCall(value: unknown): AgentToolCall | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const toolName = readToolName(value.toolName ?? value.tool_name ?? value.name);
  if (toolName === undefined) {
    return undefined;
  }

  return {
    toolName,
    args: isRecord(value.args) ? value.args : {},
    reason: readOptionalString(value.reason),
  };
}

function readToolName(value: unknown): AgentToolName | undefined {
  const toolName = readOptionalString(value);
  return toolName === undefined ? undefined : toolName;
}

function readConfidence(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  return undefined;
}

function readObjectIDs(value: unknown): Array<number | string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is number | string => typeof item === "number" || typeof item === "string");
}
