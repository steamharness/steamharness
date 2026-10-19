import type { KVContext } from "../kv/index";
import { createHash } from "node:crypto";

export const TOKEN_USAGE_TOTAL_KEY = "tokenUsage.total";
export const TOKEN_USAGE_ENTRY_KEY_PREFIX = "tokenUsage.entry.";

export interface TokenUsageDefinition {
  enabled: boolean;
  display?: boolean;
}

export interface TokenUsageReportInput {
  /** Stable identity for an upserted billing record, including recovery replay. */
  recordId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  nodeName?: string;
  providerName?: string;
  modelId?: string;
  metadata?: Record<string, unknown>;
}

export interface TokenUsageEntry {
  id: string;
  projectId: string;
  runId: string;
  conversationId?: string;
  sequence: number;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  nodeName?: string;
  providerName?: string;
  modelId?: string;
  metadata?: Record<string, unknown>;
}

export interface TokenUsageAggregate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  calls: number;
  updatedAt?: string;
}

export interface TokenUsageContext {
  enabled: boolean;
  display: boolean;
  report(input: TokenUsageReportInput): Promise<TokenUsageEntry | undefined>;
  getRunUsage(): TokenUsageAggregate;
}

export interface TokenUsageContextOptions {
  definition?: TokenUsageDefinition;
  kv: KVContext;
  projectId: string;
  runId: string;
  conversationId?: string;
  onUpdate?(aggregate: TokenUsageAggregate): Promise<void> | void;
}

export function createDisabledWorkflowTokenUsageContext(): TokenUsageContext {
  return {
    enabled: false,
    display: false,
    async report() {
      return undefined;
    },
    getRunUsage() {
      return createEmptyTokenUsageAggregate();
    },
  };
}

export function createWorkflowTokenUsageContext(
  options: TokenUsageContextOptions,
): TokenUsageContext {
  if (options.definition?.enabled !== true) {
    return createDisabledWorkflowTokenUsageContext();
  }

  // Token usage is executor-level opt-in: enabled controls KV writes, while
  // display is carried to reports so UI badges can be hidden without losing
  // accounting data.
  const display = options.definition.display ?? true;
  let sequence = 0;
  let runUsage = createEmptyTokenUsageAggregate();
  const runRecords = new Map<string, TokenUsageEntry>();

  return {
    enabled: true,
    display,
    async report(input) {
      const entryUsage = normalizeTokenUsage(input);
      if (entryUsage.totalTokens <= 0) {
        return undefined;
      }

      sequence += 1;
      const createdAt = new Date().toISOString();
      const recordId = normalizeOptionalString(input.recordId);
      const entry: TokenUsageEntry = {
        id: recordId ?? `${options.runId}.${sequence}`,
        projectId: options.projectId,
        runId: options.runId,
        conversationId: options.conversationId,
        sequence,
        createdAt,
        inputTokens: entryUsage.inputTokens,
        outputTokens: entryUsage.outputTokens,
        totalTokens: entryUsage.totalTokens,
        reasoningTokens: entryUsage.reasoningTokens,
        cachedInputTokens: entryUsage.cachedInputTokens,
        cacheCreationTokens: entryUsage.cacheCreationTokens,
        nodeName: normalizeOptionalString(input.nodeName),
        providerName: normalizeOptionalString(input.providerName),
        modelId: normalizeOptionalString(input.modelId),
        metadata: isRecord(input.metadata) ? { ...input.metadata } : undefined,
      };

      const previous = recordId === undefined ? undefined : runRecords.get(recordId);
      runUsage = replaceUsage(runUsage, previous, entry, createdAt);
      if (recordId !== undefined) runRecords.set(recordId, entry);
      await writeTokenUsageAggregate(options.kv, entry, createdAt, recordId);
      if (options.conversationId !== undefined) {
        await options.kv.conversation.setValue(
          recordId === undefined ? createTokenUsageEntryKey(options.runId, sequence)
            : `${TOKEN_USAGE_ENTRY_KEY_PREFIX}durable.${createHash("sha256").update(recordId).digest("hex")}`,
          entry,
        );
      }
      await options.onUpdate?.(runUsage);

      return entry;
    },
    getRunUsage() {
      return cloneTokenUsageAggregate(runUsage);
    },
  };
}

export function createTokenUsageEntryKey(runId: string, sequence: number): string {
  return `${TOKEN_USAGE_ENTRY_KEY_PREFIX}${encodeTokenUsageKeyPart(runId)}.${sequence}`;
}

export function createEmptyTokenUsageAggregate(): TokenUsageAggregate {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    calls: 0,
  };
}

export function cloneTokenUsageAggregate(
  value: TokenUsageAggregate,
): TokenUsageAggregate {
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    reasoningTokens: value.reasoningTokens,
    cachedInputTokens: value.cachedInputTokens,
    cacheCreationTokens: value.cacheCreationTokens,
    calls: value.calls,
    updatedAt: value.updatedAt,
  };
}

export function addTokenUsageAggregate(
  aggregate: TokenUsageAggregate,
  usage: Pick<
    TokenUsageAggregate,
    "inputTokens" | "outputTokens" | "totalTokens" | "reasoningTokens" | "cachedInputTokens" | "cacheCreationTokens"
  >,
  updatedAt = new Date().toISOString(),
): TokenUsageAggregate {
  return {
    inputTokens: aggregate.inputTokens + usage.inputTokens,
    outputTokens: aggregate.outputTokens + usage.outputTokens,
    totalTokens: aggregate.totalTokens + usage.totalTokens,
    reasoningTokens: aggregate.reasoningTokens + usage.reasoningTokens,
    cachedInputTokens: aggregate.cachedInputTokens + usage.cachedInputTokens,
    cacheCreationTokens: aggregate.cacheCreationTokens + usage.cacheCreationTokens,
    calls: aggregate.calls + 1,
    updatedAt,
  };
}

export function isWorkflowTokenUsageAggregate(value: unknown): value is TokenUsageAggregate {
  return isRecord(value) &&
    isFiniteNumber(value.inputTokens) &&
    isFiniteNumber(value.outputTokens) &&
    isFiniteNumber(value.totalTokens) &&
    isFiniteNumber(value.reasoningTokens) &&
    isFiniteNumber(value.cachedInputTokens) &&
    isFiniteNumber(value.cacheCreationTokens) &&
    isFiniteNumber(value.calls) &&
    (value.updatedAt === undefined || typeof value.updatedAt === "string");
}

export function isWorkflowTokenUsageEntry(value: unknown): value is TokenUsageEntry {
  return readStoredTokenUsageEntry(value) !== undefined;
}

export function normalizeTokenUsage(value: TokenUsageReportInput): Omit<
  TokenUsageAggregate,
  "calls" | "updatedAt"
> {
  const inputTokens = normalizeTokenCount(value.inputTokens);
  const outputTokens = normalizeTokenCount(value.outputTokens);
  const reasoningTokens = normalizeTokenCount(value.reasoningTokens);
  const cachedInputTokens = normalizeTokenCount(value.cachedInputTokens);
  const cacheCreationTokens = normalizeTokenCount(value.cacheCreationTokens);
  const inferredTotal = inputTokens + outputTokens + reasoningTokens;
  const totalTokens = normalizeTokenCount(value.totalTokens) || inferredTotal;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheCreationTokens,
  };
}

export function readTokenUsageReportInput(
  value: unknown,
  metadata: Omit<TokenUsageReportInput, "inputTokens" | "outputTokens" | "totalTokens" | "reasoningTokens" | "cachedInputTokens" | "cacheCreationTokens"> = {},
): TokenUsageReportInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = readNumberAlias(value, ["inputTokens", "promptTokens", "input_tokens", "prompt_tokens"]);
  const outputTokens = readNumberAlias(value, ["outputTokens", "completionTokens", "output_tokens", "completion_tokens"]);
  const totalTokens = readNumberAlias(value, ["totalTokens", "total_tokens"]);
  const outputTokenDetails = readRecordProperty(value, "outputTokenDetails", "output_token_details");
  const inputTokenDetails = readRecordProperty(value, "inputTokenDetails", "input_token_details");
  const reasoningTokens = readNumberAlias(value, ["reasoningTokens", "reasoning_tokens"]) ??
    readNumberAlias(outputTokenDetails, ["reasoningTokens", "reasoning_tokens"]);
  const cachedInputTokens = readNumberAlias(value, [
    "cachedInputTokens",
    "cached_input_tokens",
    "cachedPromptTokens",
    "cached_prompt_tokens",
    "cache_read_input_tokens",
  ]) ??
    readNumberAlias(inputTokenDetails, ["cacheReadTokens", "cache_read_tokens", "cachedInputTokens", "cached_input_tokens"]);
  const cacheCreationTokens = readNumberAlias(value, [
    "cacheCreationTokens",
    "cache_creation_tokens",
    "cache_creation_input_tokens",
    "cacheWriteTokens",
    "cache_write_tokens",
  ]) ??
    readNumberAlias(inputTokenDetails, ["cacheWriteTokens", "cache_write_tokens", "cacheCreationTokens", "cache_creation_tokens"]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    reasoningTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheCreationTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...metadata,
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
    cacheCreationTokens,
  };
}

async function writeTokenUsageAggregate(
  kv: KVContext,
  entry: TokenUsageEntry,
  updatedAt: string,
  recordId?: string,
): Promise<void> {
  const updater = (current: unknown | undefined) => {
    const aggregate = readStoredTokenUsageAggregate(current)
      ?? createEmptyTokenUsageAggregate();

    if (recordId === undefined) return { ...(isRecord(current) ? current : {}), ...addTokenUsageAggregate(aggregate, entry, updatedAt) };
    // The receipt and aggregate change in the same KV update. A crash between
    // project and conversation writes is repaired by replaying the same receipt.
    const receipts = isRecord(current) && isRecord(current.durableReceipts) ? current.durableReceipts : {};
    const previous = readStoredTokenUsageEntry(receipts[recordId]);
    return { ...replaceUsage(aggregate, previous, entry, updatedAt), durableReceipts: { ...receipts, [recordId]: entry } };
  };

  // System totals are derived by aggregating project totals. Only the current
  // project and, when present, its conversation are written here.
  await kv.updateValue(TOKEN_USAGE_TOTAL_KEY, updater);

  if (entry.conversationId !== undefined) {
    await kv.conversation.updateValue(TOKEN_USAGE_TOTAL_KEY, updater);
  }
}

function replaceUsage(aggregate: TokenUsageAggregate, previous: TokenUsageEntry | undefined,
  entry: TokenUsageEntry, updatedAt: string): TokenUsageAggregate {
  if (previous === undefined) return addTokenUsageAggregate(aggregate, entry, updatedAt);
  return { inputTokens: aggregate.inputTokens - previous.inputTokens + entry.inputTokens,
    outputTokens: aggregate.outputTokens - previous.outputTokens + entry.outputTokens,
    totalTokens: aggregate.totalTokens - previous.totalTokens + entry.totalTokens,
    reasoningTokens: aggregate.reasoningTokens - previous.reasoningTokens + entry.reasoningTokens,
    cachedInputTokens: aggregate.cachedInputTokens - previous.cachedInputTokens + entry.cachedInputTokens,
    cacheCreationTokens: aggregate.cacheCreationTokens - previous.cacheCreationTokens + entry.cacheCreationTokens,
    calls: aggregate.calls, updatedAt };
}

export function readStoredTokenUsageAggregate(value: unknown): TokenUsageAggregate | undefined {
  if (!isRecord(value) ||
    !isFiniteNumber(value.inputTokens) ||
    !isFiniteNumber(value.outputTokens) ||
    !isFiniteNumber(value.totalTokens) ||
    !isFiniteNumber(value.reasoningTokens) ||
    !isFiniteNumber(value.cachedInputTokens) ||
    !isFiniteNumber(value.calls) ||
    !(value.updatedAt === undefined || typeof value.updatedAt === "string")
  ) {
    return undefined;
  }

  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    reasoningTokens: value.reasoningTokens,
    cachedInputTokens: value.cachedInputTokens,
    cacheCreationTokens: isFiniteNumber(value.cacheCreationTokens) ? value.cacheCreationTokens : 0,
    calls: value.calls,
    updatedAt: value.updatedAt,
  };
}

export function readStoredTokenUsageEntry(value: unknown): TokenUsageEntry | undefined {
  if (!isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.runId !== "string" ||
    !(value.conversationId === undefined || typeof value.conversationId === "string") ||
    !isFiniteNumber(value.sequence) ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }

  const usage = readStoredTokenUsageAggregate({
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens: value.totalTokens,
    reasoningTokens: value.reasoningTokens,
    cachedInputTokens: value.cachedInputTokens,
    cacheCreationTokens: value.cacheCreationTokens,
    calls: 1,
    updatedAt: value.createdAt,
  });
  if (usage === undefined) {
    return undefined;
  }

  return {
    id: value.id,
    projectId: value.projectId,
    runId: value.runId,
    conversationId: value.conversationId,
    sequence: value.sequence,
    createdAt: value.createdAt,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    nodeName: normalizeOptionalString(value.nodeName),
    providerName: normalizeOptionalString(value.providerName),
    modelId: normalizeOptionalString(value.modelId),
    metadata: isRecord(value.metadata) ? { ...value.metadata } : undefined,
  };
}

function normalizeTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.floor(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
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

function encodeTokenUsageKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
