import type { OutputItemStreamChunk, RunOutputItemInput } from "../node/output/index";
import type { AgentSearchSource } from "./types";

export function formatAgentSearchSources(sources: readonly AgentSearchSource[]): string {
  return sources.flatMap(source => {
    try { if (!["http:", "https:"].includes(new URL(source.url).protocol)) return []; } catch { return []; }
    const label = (source.title || source.url).replace(/[\\`*_[\]{}()!|<>]/g, "\\$&").replace(/[\r\n]/g, " ");
    const url = source.url.replace(/[\\<>\s]/g, char => encodeURIComponent(char));
    return [`- [${label}](<${url}>)`];
  }).join("\n");
}

/**
 * Output-item metadata this package emits.
 *
 * The names are deliberately neutral (`agent-*`, not a vendor prefix) so the
 * shape is a contract any host can render. The item *content* follows the same
 * field layout the built-in OpenCode project already produces, which is why a
 * host that renders those rows can reuse its presentation with a one-line
 * alias instead of a second renderer.
 */
export const AGENT_OUTPUT_KINDS = {
  /** A collapsed detail row; `metadata.partType` says which kind. */
  part: "agent-part",
  /** A plain markdown note, always visible. */
  notice: "agent-notice",
  /** A failed run, rendered with the error presentation. */
  error: "agent-error",
  /** The assistant's own answer. */
  answer: "agent-answer",
} as const;

export type AgentOutputKind = (typeof AGENT_OUTPUT_KINDS)[keyof typeof AGENT_OUTPUT_KINDS];

export type AgentOutputPartType =
  | "reasoning"
  | "tool"
  | "patch"
  | "compaction"
  | "retry"
  | "plan"
  | "file"
  /**
   * A run of the turn's text, written where it was spoken.
   *
   * The answer item holds the whole turn and is what a host reads back as the
   * response text, so it cannot also carry a transcript's row positions. A
   * conversation writes its text as these rows instead, one per run of text
   * between two activity rows, the way the built-in OpenCode project writes
   * its text parts.
   */
  | "text";

export type AgentOutputStatus = "running" | "success" | "failed";

export const AGENT_ANSWER_ITEM_ID = "agent-answer";

const COMPACTED_KIND_PREFIX = "agent";

export interface AgentOutputItemPatch {
  title: string;
  iconPreset: NonNullable<RunOutputItemInput["iconPreset"]>;
  contentType: NonNullable<RunOutputItemInput["contentType"]>;
  collapsed: boolean;
  metadata: Record<string, unknown>;
}

/** Collapsed JSON row used by every detail item this package emits. */
export function createAgentDetailPatch(
  title: string,
  iconPreset: NonNullable<RunOutputItemInput["iconPreset"]>,
  status: AgentOutputStatus,
  metadata: Record<string, unknown> = {},
): AgentOutputItemPatch {
  return {
    title,
    iconPreset,
    contentType: "json",
    collapsed: true,
    metadata: { kind: AGENT_OUTPUT_KINDS.part, status, ...metadata },
  };
}

export function createAgentOutputItemId(id: string): string {
  return `${COMPACTED_KIND_PREFIX}-${id.replace(/[^A-Za-z0-9_.:-]+/g, "-")}`;
}

/**
 * Where each output item ended, so a turn can be read in the order it happened.
 *
 * An item takes the position where it *started*, and a host renders the payload
 * in that order. That is fine until an item keeps receiving chunks after other
 * rows have appeared: the answer streams its first sentence, the model calls a
 * tool, and the rest of the answer lands back in the item that is still sitting
 * above the tool it just followed. Ordering by the last chunk puts each row
 * where it finished, which is what "the explanation comes after the work"
 * means on screen.
 */
export function createAgentItemOrderTracker(): {
  observe(chunk: OutputItemStreamChunk): void;
  ids(): string[];
} {
  const lastSeen = new Map<string, number>();
  let index = 0;

  return {
    observe(chunk) {
      index += 1;
      const id = readChunkItemId(chunk);
      if (id !== undefined) {
        lastSeen.set(id, index);
      }
    },
    ids() {
      return [...lastSeen.entries()]
        .sort((left, right) => left[1] - right[1])
        .map(([id]) => id);
    },
  };
}

/** The same order, applied to the items a stream accumulated. */
export function applyAgentItemOrder(
  items: readonly RunOutputItemInput[],
  order: readonly string[] | undefined,
): RunOutputItemInput[] {
  if (order === undefined || order.length === 0) {
    return [...items];
  }

  const rank = new Map(order.map((id, index) => [id, index]));
  const rankOf = (item: RunOutputItemInput) =>
    item.id === undefined ? order.length : rank.get(item.id) ?? order.length;

  // Items the order does not name (none today) keep their relative place after
  // the ones it does.
  return [...items].sort((left, right) => rankOf(left) - rankOf(right));
}

export function orderAgentOutputItems(
  items: readonly RunOutputItemInput[],
  chunks: readonly OutputItemStreamChunk[],
): RunOutputItemInput[] {
  const tracker = createAgentItemOrderTracker();
  for (const chunk of chunks) {
    tracker.observe(chunk);
  }

  return applyAgentItemOrder(items, tracker.ids());
}

function readChunkItemId(chunk: OutputItemStreamChunk): string | undefined {
  const id = chunk.type === "output_item_start" ? chunk.item.id : chunk.itemId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * The assistant's own answer.
 *
 * Left expanded and rendered as markdown: the workspace contract requires the
 * main answer to be visible in the conversation body rather than folded into a
 * detail block. `part: true` writes one run of a conversation's text instead —
 * same layout, but marked as a detail row so a host can tell the two apart.
 */
export function createAgentTextChunks(options: {
  itemId?: string;
  delta: string;
  completed: boolean;
  started?: boolean;
  part?: boolean;
}): OutputItemStreamChunk[] {
  const itemId = options.itemId ?? createAgentOutputItemId(AGENT_ANSWER_ITEM_ID);
  const chunks: OutputItemStreamChunk[] = [];

  if (options.started !== true) {
    if (options.delta === "" && !options.completed) {
      return [];
    }
    chunks.push({
      type: "output_item_start",
      item: {
        id: itemId,
        title: "Output",
        content: "",
        contentType: "markdown",
        collapsed: false,
        metadata: options.part === true
          ? { kind: AGENT_OUTPUT_KINDS.part, partType: "text" satisfies AgentOutputPartType }
          : { kind: AGENT_OUTPUT_KINDS.answer },
      },
    });
  }

  if (options.delta !== "") {
    chunks.push({ type: "output_item_delta", itemId, delta: options.delta });
  }

  if (options.completed) {
    chunks.push({ type: "output_item_end", itemId });
  }

  return chunks;
}

/**
 * The plan a plan-mode turn produces.
 *
 * It is the turn's whole product, so it takes the place of the answer rather
 * than accompanying it: streaming it into both showed the same text twice, once
 * laid out in the conversation body and once in the Plan row.
 */
export function createAgentPlanChunks(options: {
  itemId: string;
  delta: string;
  completed: boolean;
  started?: boolean;
}): OutputItemStreamChunk[] {
  const chunks: OutputItemStreamChunk[] = [];

  if (options.started !== true) {
    if (options.delta === "" && !options.completed) {
      return [];
    }
    chunks.push({
      type: "output_item_start",
      item: {
        id: options.itemId,
        title: "Plan",
        content: "",
        contentType: "markdown",
        iconPreset: "info",
        collapsed: false,
        metadata: { kind: AGENT_OUTPUT_KINDS.notice, plan: true },
      },
    });
  }

  if (options.delta !== "") {
    chunks.push({ type: "output_item_delta", itemId: options.itemId, delta: options.delta });
  }

  if (options.completed) {
    chunks.push({ type: "output_item_end", itemId: options.itemId });
  }

  return chunks;
}

export function createAgentReasoningChunks(options: {
  itemId: string;
  text: string;
  status: AgentOutputStatus;
  startedAt?: number;
  endedAt?: number;
  started?: boolean;
}): OutputItemStreamChunk[] {
  return createAgentPartChunks({
    itemId: options.itemId,
    partType: "reasoning",
    status: options.status,
    content: {
      type: "reasoning",
      status: options.status,
      text: options.text,
      ...(options.startedAt === undefined ? {} : { startedAt: options.startedAt }),
      ...(options.endedAt === undefined ? {} : { endedAt: options.endedAt }),
    },
    patch: {
      title: options.status === "running"
        ? "Thinking"
        : options.status === "failed"
          ? "Reasoning failed"
          : "Reasoning",
      iconPreset: options.status === "failed" ? "error" : "note",
    },
    ...(options.started === undefined ? {} : { started: options.started }),
  });
}

export function createAgentToolChunks(options: {
  itemId: string;
  toolName: string;
  status: AgentOutputStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  title?: string;
  started?: boolean;
}): OutputItemStreamChunk[] {
  const content: Record<string, unknown> = {
    type: "tool",
    status: options.status,
    tool: options.toolName,
    callId: options.itemId,
    input: isRecord(options.input) ? options.input : {},
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.error === undefined ? {} : { error: options.error }),
  };

  return createAgentPartChunks({
    itemId: options.itemId,
    partType: "tool",
    status: options.status,
    content,
    patch: {
      title: options.title ?? `Running tool: ${options.toolName}`,
      iconPreset: options.status === "failed" ? "error" : options.status === "success" ? "success" : "code",
    },
    ...(options.started === undefined ? {} : { started: options.started }),
  });
}

export function createAgentCompactionChunks(options: {
  itemId: string;
  status: AgentOutputStatus;
  auto: boolean;
  summary?: string;
  started?: boolean;
}): OutputItemStreamChunk[] {
  const summary = options.summary?.trim() ?? "";
  return createAgentPartChunks({
    itemId: options.itemId,
    partType: "compaction",
    status: options.status,
    content: {
      type: "compaction",
      status: options.status,
      auto: options.auto,
      ...(summary === "" ? {} : { summary }),
    },
    patch: {
      title: options.status === "running" ? "Summarizing context" : options.status === "failed" ? "Failed context compaction" : "Completed context compaction",
      iconPreset: options.status === "failed" ? "error" : "note",
    },
    ...(options.started === undefined ? {} : { started: options.started }),
  });
}

/**
 * One attempt at continuing a turn whose model stream died mid-answer.
 *
 * Collapsed like the other activity rows: a run that has to ride out a flaky
 * endpoint can spend the whole budget, and ten expanded paragraphs saying the
 * same thing would push the answer it is producing off the screen.
 */
export function createAgentRetryChunks(options: {
  itemId: string;
  attempt: number;
  maxAttempts: number;
  reason: string;
  title: string;
  message: string;
}): OutputItemStreamChunk[] {
  return createAgentPartChunks({
    itemId: options.itemId,
    partType: "retry",
    status: "success",
    content: {
      type: "retry",
      status: "success",
      attempt: options.attempt,
      maxAttempts: options.maxAttempts,
      reason: options.reason,
      message: options.message,
    },
    patch: { title: options.title, iconPreset: "warning" },
  });
}

export function createAgentNoticeChunks(options: {
  id: string;
  title: string;
  content: string;
}): OutputItemStreamChunk[] {
  const itemId = createAgentOutputItemId(options.id);
  return [
    {
      type: "output_item_start",
      item: {
        id: itemId,
        title: options.title,
        content: options.content,
        contentType: "markdown",
        iconPreset: "info",
        collapsed: false,
        metadata: { kind: AGENT_OUTPUT_KINDS.notice, status: "success" },
      },
    },
    { type: "output_item_end", itemId },
  ];
}

export function createAgentErrorChunks(options: {
  id: string;
  message: string;
  error?: unknown;
}): OutputItemStreamChunk[] {
  const itemId = createAgentOutputItemId(`error-${options.id}`);
  const patch = createAgentDetailPatch("Agent error", "error", "failed", {
    kind: AGENT_OUTPUT_KINDS.error,
    partType: "error",
  });

  return [
    {
      type: "output_item_start",
      item: {
        id: itemId,
        ...patch,
        content: {
          type: "error",
          status: "failed",
          message: options.message,
          ...(options.error === undefined ? {} : { error: options.error }),
        },
      },
    },
    { type: "output_item_end", itemId },
  ];
}

function createAgentPartChunks(options: {
  itemId: string;
  partType: AgentOutputPartType;
  status: AgentOutputStatus;
  content: Record<string, unknown>;
  patch: { title: string; iconPreset: NonNullable<RunOutputItemInput["iconPreset"]> };
  started?: boolean;
}): OutputItemStreamChunk[] {
  const item: RunOutputItemInput = {
    id: options.itemId,
    title: options.patch.title,
    content: options.content,
    iconPreset: options.patch.iconPreset,
    contentType: "json",
    collapsed: true,
    metadata: {
      kind: AGENT_OUTPUT_KINDS.part,
      partType: options.partType,
      status: options.status,
    },
  };

  const chunks: OutputItemStreamChunk[] = [];
  if (options.started !== true) {
    chunks.push({ type: "output_item_start", item });
  }
  chunks.push({
    type: "output_item_delta",
    itemId: options.itemId,
    delta: options.content,
    item,
  });
  if (options.status !== "running") {
    chunks.push({ type: "output_item_end", itemId: options.itemId });
  }

  return chunks;
}

export function readAgentPartStatus(status: AgentOutputStatus): string {
  return status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
