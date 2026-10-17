import type {
  CompactedHistory,
  ConversationChatMessage,
  ContextBudget,
  ContextEntry,
  ContextPartition,
  ReactStep,
} from "../interface";

const DEFAULT_TOTAL_TOKENS = 128000;
const DEFAULT_OUTPUT_TOKENS = 1600;
const DEFAULT_SYSTEM_PROMPT_TOKENS = 8000;
const CHARS_PER_TOKEN = 3;
const COMPACTION_THRESHOLD = 0.8;
const HISTORY_COMPACTION_MESSAGE_THRESHOLD = 10;
const RECENT_HISTORY_KEEP = 4;
const RECENT_STEPS_KEEP = 2;

export function createContextBudget(options?: {
  totalTokens?: number;
  systemPromptTokens?: number;
  outputTokens?: number;
}): ContextBudget {
  const totalTokens = options?.totalTokens ?? DEFAULT_TOTAL_TOKENS;
  const systemPromptTokens = options?.systemPromptTokens ?? DEFAULT_SYSTEM_PROMPT_TOKENS;
  const outputTokens = options?.outputTokens ?? DEFAULT_OUTPUT_TOKENS;
  const availableTokens = totalTokens - systemPromptTokens - outputTokens;

  return { totalTokens, systemPromptTokens, outputTokens, availableTokens };
}

export function createContextPartition(available: number): ContextPartition {
  return {
    historyBudget: Math.floor(available * 0.3),
    stepsBudget: Math.floor(available * 0.6),
    queryBudget: Math.floor(available * 0.1),
  };
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function scoreRelevance(content: string, query: string): number {
  const queryTerms = extractTerms(query);
  if (queryTerms.length === 0) return 0.1;

  let score = 0.1;
  const contentLower = content.toLowerCase();

  for (const term of queryTerms) {
    if (contentLower.includes(term.toLowerCase())) {
      score += 0.4 / queryTerms.length;
    }
  }

  return Math.min(1.0, score);
}

export function scoreRecency(timestamp: string | undefined, now: Date = new Date()): number {
  if (!timestamp) return 0.5;

  const elapsed = now.getTime() - new Date(timestamp).getTime();
  const minutes = elapsed / 60000;

  if (minutes <= 5) return 1.0;
  if (minutes <= 30) return 0.7;
  if (minutes <= 120) return 0.4;
  return 0.1;
}

export function computeEntryValue(relevance: number, recency: number): number {
  return relevance * 0.6 + recency * 0.4;
}

export function selectEntries(entries: ContextEntry[], budgetTokens: number): ContextEntry[] {
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  const selected: ContextEntry[] = [];
  let used = 0;

  for (const entry of sorted) {
    if (used + entry.tokens > budgetTokens) continue;
    selected.push(entry);
    used += entry.tokens;
  }

  return selected;
}

export function compactSteps(steps: ReactStep[], budgetTokens: number): string {
  const recentCount = Math.min(RECENT_STEPS_KEEP, steps.length);
  const recentSteps = steps.slice(-recentCount);
  const olderSteps = steps.slice(0, -recentCount || steps.length);

  const parts: string[] = [];

  if (olderSteps.length > 0) {
    const summaries = olderSteps.map((step) => {
      const tool = step.action ? `${step.action.toolName}(${formatCompactArgs(step.action.args)})` : "无工具调用";
      const status = step.status === "observed" ? "成功" : step.status === "failed" ? "失败" : "计划中";
      return `第${step.round}轮: ${step.thought.summary} → ${tool} [${status}]`;
    });
    parts.push("[早期步骤摘要]");
    parts.push(summaries.join("\n"));
    parts.push("");
  }

  if (recentSteps.length > 0) {
    parts.push("[最近步骤详情]");
    parts.push(JSON.stringify(recentSteps.map(createCompactStep), null, 2));
  }

  const result = parts.join("\n");
  const tokens = estimateTokens(result);

  if (tokens <= budgetTokens) return result;

  return compactStepsAggressive(steps, budgetTokens);
}

export function compactHistory(
  messages: ConversationChatMessage[],
  compacted: CompactedHistory | undefined,
  budgetTokens: number,
): string {
  const parts: string[] = [];

  if (compacted?.summary) {
    parts.push(`[历史摘要] ${compacted.summary}`);
    parts.push("");
  }

  const uncoveredStart = compacted?.coveredMessageCount ?? 0;
  const uncovered = messages.slice(uncoveredStart);

  if (uncovered.length === 0 && !compacted?.summary) {
    return "暂无。";
  }

  if (uncovered.length === 0) {
    return parts.join("\n");
  }

  const recentMessages = uncovered.slice(-RECENT_HISTORY_KEEP);
  const formatted = recentMessages.map(formatHistoryMessage).join("\n\n");
  parts.push(formatted);

  const result = parts.join("\n");
  if (estimateTokens(result) <= budgetTokens) return result;

  const minimal = recentMessages.slice(-2).map(formatHistoryMessage).join("\n\n");
  return compacted?.summary
    ? `[历史摘要] ${compacted.summary}\n\n${minimal}`
    : minimal;
}

export function shouldCompactHistory(
  messageCount: number,
  compacted: CompactedHistory | undefined,
): boolean {
  const uncovered = messageCount - (compacted?.coveredMessageCount ?? 0);
  return uncovered >= HISTORY_COMPACTION_MESSAGE_THRESHOLD;
}

export function createCompactedHistorySummary(
  messages: ConversationChatMessage[],
  existing: CompactedHistory | undefined,
): CompactedHistory {
  const coveredCount = existing?.coveredMessageCount ?? 0;
  const newMessages = messages.slice(coveredCount, -RECENT_HISTORY_KEEP);

  if (newMessages.length === 0) {
    return existing ?? createEmptyCompactedHistory();
  }

  const entities = extractEntitiesFromMessages(newMessages);
  const queries = extractRecentQueries(newMessages);
  const summaryParts = newMessages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content.slice(0, 100))
    .slice(-5);

  const existingSummary = existing?.summary ?? "";
  const newSummary = summaryParts.join("；");
  const combined = existingSummary
    ? `${existingSummary}；${newSummary}`
    : newSummary;

  return {
    summary: combined.slice(0, 800),
    coveredMessageCount: messages.length - RECENT_HISTORY_KEEP,
    lastCompactedAt: new Date().toISOString(),
    entities: [...new Set([...(existing?.entities ?? []), ...entities])].slice(0, 50),
    recentQueries: [...(existing?.recentQueries ?? []), ...queries].slice(-10),
  };
}

export function createEmptyCompactedHistory(): CompactedHistory {
  return {
    summary: "",
    coveredMessageCount: 0,
    lastCompactedAt: new Date().toISOString(),
    entities: [],
    recentQueries: [],
  };
}

export function needsCompaction(
  partition: ContextPartition,
  historyTokens: number,
  stepsTokens: number,
): { history: boolean; steps: boolean } {
  return {
    history: historyTokens > partition.historyBudget * COMPACTION_THRESHOLD,
    steps: stepsTokens > partition.stepsBudget * COMPACTION_THRESHOLD,
  };
}

function createCompactStep(step: ReactStep): unknown {
  return {
    round: step.round,
    thought: step.thought,
    action: step.action,
    observation: step.observation,
    toolResult: step.toolResult ? {
      toolName: step.toolResult.toolName,
      ok: step.toolResult.ok,
      summary: step.toolResult.summary,
      data: step.toolResult.data,
    } : undefined,
    status: step.status,
  };
}

function compactStepsAggressive(steps: ReactStep[], budgetTokens: number): string {
  const summaries = steps.map((step) => {
    const tool = step.action ? step.action.toolName : "无";
    const status = step.status === "observed" ? "ok" : step.status;
    const obs = step.observation ? step.observation.slice(0, 80) : "";
    return `R${step.round}: ${step.thought.summary.slice(0, 60)} → ${tool}[${status}] ${obs}`;
  });

  const result = summaries.join("\n");
  if (estimateTokens(result) <= budgetTokens) return result;

  return summaries.slice(-3).join("\n");
}

function formatCompactArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}:${typeof v === "string" ? v.slice(0, 20) : String(v)}`)
    .join(",");
}

function formatHistoryMessage(message: ConversationChatMessage): string {
  const ts = message.metadata?.timestamp ? ` [${message.metadata.timestamp}]` : "";
  const tools = message.metadata?.toolCalls ? `\n  (工具: ${message.metadata.toolCalls})` : "";
  return `[${message.role}]${ts}: ${message.content}${tools}`;
}

function extractTerms(text: string): string[] {
  const terms = text
    .replace(/[，。！？、；：""''（）【】《》\s]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2);
  return [...new Set(terms)];
}

function extractEntitiesFromMessages(messages: ConversationChatMessage[]): string[] {
  const entities: string[] = [];
  const idPattern = /\b\d{8,}\b/g;
  const namePattern = /(?:M[0-9]+|AK[0-9]*|MP[0-9]+|HK[0-9]+|[A-Z]{2,}[-\s]?[0-9]+)/g;

  for (const msg of messages) {
    const ids = msg.content.match(idPattern) ?? [];
    const names = msg.content.match(namePattern) ?? [];
    entities.push(...ids.slice(0, 5), ...names.slice(0, 5));
  }

  return [...new Set(entities)].slice(0, 30);
}

function extractRecentQueries(messages: ConversationChatMessage[]): CompactedHistory["recentQueries"] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => ({
      query: m.content.slice(0, 100),
      timestamp: m.metadata?.timestamp ?? new Date().toISOString(),
      toolsUsed: [],
      keyFacts: [],
    }))
    .slice(-5);
}
