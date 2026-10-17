import { BaseNode, BaseStreamNode } from "../base";
import type { NodeContext, WorkflowNodeMetadataInput, WorkflowPayload } from "../../types/index";
import type { LLMStreamChunk } from "../../provider/llm/types";

export type OutputFormatter<Input, Output> = (
  input: Input,
  context: NodeContext,
) => Promise<Output> | Output;

export type OutputStreamer<Input> = (
  input: Input,
  context: NodeContext,
) => AsyncIterable<OutputStreamChunk> | Iterable<OutputStreamChunk>;

export type OutputStreamFormatter<Input, Output> = (
  stream: OutputStreamAccumulator,
  input: Input,
  context: NodeContext,
) => Promise<Output> | Output;

export interface OutputNodeOptions<Input, Output> {
  name?: string;
  format?: OutputFormatter<Input, Output>;
  historyLimit?: number;
  metadata?: WorkflowNodeMetadataInput;
}

export interface OutputStreamNodeOptions<Input, Output> {
  name?: string;
  stream: OutputStreamer<Input>;
  format: OutputStreamFormatter<Input, Output>;
  historyLimit?: number;
  metadata?: WorkflowNodeMetadataInput;
}

export const DETAILS_OUTPUT_ICON_PRESETS = {
  info: "[i]",
  success: "[ok]",
  warning: "[!]",
  error: "[x]",
  note: "[note]",
  code: "[code]",
  list: "[list]",
  quote: "[quote]",
  none: "",
} as const;

export type DetailsOutputIconPreset = keyof typeof DETAILS_OUTPUT_ICON_PRESETS;
export type DetailsOutputIcon = DetailsOutputIconPreset | string;
export type WorkflowOutputContentType = "markdown" | "text" | "json" | "audio" | "video";
export interface WorkflowOutputDisplay {
  type: "ring";
  placement?: "inline" | "composer-right";
}

export interface WorkflowRingContent {
  value: number;
  total?: number;
  unit?: string;
}

export type DetailsOutputStaticContent =
  | string
  | number
  | boolean
  | bigint
  | null
  | readonly unknown[]
  | Record<string, unknown>;

export interface WorkflowOutputItem {
  id: string;
  title: string;
  content: unknown;
  icon?: string;
  iconPreset?: DetailsOutputIconPreset;
  contentType?: WorkflowOutputContentType;
  display?: WorkflowOutputDisplay;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowOutputItemInput {
  id?: string;
  title: string;
  content: unknown;
  icon?: DetailsOutputIcon;
  iconPreset?: DetailsOutputIconPreset;
  contentType?: WorkflowOutputContentType;
  display?: WorkflowOutputDisplay;
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowOutputPayload extends WorkflowPayload {
  items: WorkflowOutputItem[];
  [key: string]: unknown;
}

export type OutputItemChunkOperation = "output_item_start" | "output_item_delta" | "output_item_end";

export type OutputItemStreamChunk =
  | {
      type: "output_item_start";
      item: WorkflowOutputItemInput;
    }
  | {
      type: "output_item_delta";
      itemId: string;
      delta: unknown;
      item?: Partial<WorkflowOutputItemInput>;
    }
  | {
      type: "output_item_end";
      itemId: string;
    };

export type OutputStreamChunk = string | OutputItemStreamChunk;

export interface OutputStreamAccumulator {
  text: string;
  items: WorkflowOutputItem[];
  chunks: OutputStreamChunk[];
}

export interface DetailsOutputInput {
  title: string;
  content: unknown;
  icon?: DetailsOutputIcon;
}

export interface DetailsOutputBlock {
  title: string;
  content: unknown;
  icon?: DetailsOutputIcon;
}

export interface ResolvedDetailsOutputBlock {
  title: string;
  content: unknown;
  contentType: WorkflowOutputContentType;
  icon: string;
  iconPreset?: DetailsOutputIconPreset;
}

export interface DetailsOutputPayload extends WorkflowOutputPayload {}

export type DetailsOutputFieldResolver<Input> = (
  input: Input,
  context: NodeContext,
) => Promise<unknown> | unknown;

export type DetailsOutputResolver<Input> = (
  input: Input,
  context: NodeContext,
) => Promise<DetailsOutputBlock> | DetailsOutputBlock;

export type DetailsOutputFormatter<Input, Output> = (
  payload: DetailsOutputPayload,
  details: ResolvedDetailsOutputBlock,
  input: Input,
  context: NodeContext,
) => Promise<Output> | Output;

export interface DetailsOutputNodeOptions<Input, Output extends WorkflowPayload = DetailsOutputPayload> {
  name?: string;
  title?: string | DetailsOutputFieldResolver<Input>;
  content?: DetailsOutputStaticContent | DetailsOutputFieldResolver<Input>;
  icon?: DetailsOutputIcon | DetailsOutputFieldResolver<Input>;
  resolve?: DetailsOutputResolver<Input>;
  format?: DetailsOutputFormatter<Input, Output>;
  historyLimit?: number;
  metadata?: WorkflowNodeMetadataInput;
}

export function createOutputNode<Input, Output>(
  options: OutputStreamNodeOptions<Input, Output>,
): BaseStreamNode<Input, OutputStreamChunk, Output>;
export function createOutputNode<Input, Output>(
  options: OutputNodeOptions<Input, Output> & {
    format: OutputFormatter<Input, Output>;
  },
): BaseNode<Input, Output>;
export function createOutputNode<Input>(
  options?: OutputNodeOptions<Input, Input>,
): BaseNode<Input, Input>;
export function createOutputNode<Input, Output = Input>(
  options: OutputNodeOptions<Input, Output> | OutputStreamNodeOptions<Input, Output> = {},
): BaseNode<Input, Output> | BaseStreamNode<Input, OutputStreamChunk, Output> {
  if ("stream" in options) {
    return new OutputStreamNode(options);
  }

  return new OutputNode(options);
}

export function createDetailsOutputNode<
  Input = DetailsOutputInput,
  Output extends WorkflowPayload = DetailsOutputPayload,
>(
  options: DetailsOutputNodeOptions<Input, Output> = {},
): BaseNode<Input, Output> {
  return createOutputNode<Input, Output>({
    name: options.name ?? "output",
    historyLimit: options.historyLimit,
    metadata: {
      type: "details-output",
      title: "Details Output",
      ...options.metadata,
    },
    // Details output nodes still use the output standardName so CLI/App/server collect their content as user-visible output.
    async format(input, context) {
      const details = await resolveDetailsOutputBlock(input, context, options);
      const payload = createDetailsOutputPayload(details);
      return options.format === undefined
        ? payload as unknown as Output
        : options.format(payload, details, input, context);
    },
  });
}

class OutputNode<Input, Output> extends BaseNode<Input, Output> {
  private readonly format?: OutputFormatter<Input, Output>;

  constructor(options: OutputNodeOptions<Input, Output>) {
    super({
      name: options.name ?? "output",
      standardName: "output",
      historyLimit: options.historyLimit,
      metadata: options.metadata,
    });
    this.format = options.format;
  }

  protected async execute(input: Input, context: NodeContext): Promise<Output> {
    if (this.format) {
      return this.format(input, context);
    }

    return input as unknown as Output;
  }
}

class OutputStreamNode<Input, Output> extends BaseStreamNode<Input, OutputStreamChunk, Output> {
  private readonly outputStream: OutputStreamer<Input>;
  private readonly format: OutputStreamFormatter<Input, Output>;

  constructor(options: OutputStreamNodeOptions<Input, Output>) {
    super({
      name: options.name ?? "output",
      standardName: "output",
      historyLimit: options.historyLimit,
      metadata: options.metadata,
    });
    this.outputStream = options.stream;
    this.format = options.format;
  }

  protected async *createStream(
    input: Input,
    context: NodeContext,
  ): AsyncIterable<OutputStreamChunk> {
    yield* this.outputStream(input, context);
  }

  finalize(
    chunks: OutputStreamChunk[],
    context: NodeContext,
    input?: Input,
  ): Promise<Output> | Output {
    if (input === undefined) {
      throw new Error("Output stream node finalize requires input.");
    }

    return this.format(createOutputStreamAccumulator(chunks), input, context);
  }
}

export function collectLLMStreamText(chunks: LLMStreamChunk[]): string {
  return chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.text)
    .join("");
}

async function resolveDetailsOutputBlock<Input, Output extends WorkflowPayload>(
  input: Input,
  context: NodeContext,
  options: DetailsOutputNodeOptions<Input, Output>,
): Promise<ResolvedDetailsOutputBlock> {
  const source = options.resolve === undefined
    ? readInputDetailsBlock(input)
    : await options.resolve(input, context);
  const title = await resolveDetailsField(options.title, input, context, source.title);
  const content = await resolveDetailsField(options.content, input, context, source.content);
  const icon = await resolveDetailsField(options.icon, input, context, source.icon);
  const resolvedIcon = resolveDetailsOutputIcon(icon);

  return {
    title: stringifyDetailsValue(title).trim() || "Details",
    content,
    contentType: inferOutputContentType(content),
    icon: resolvedIcon.value,
    iconPreset: resolvedIcon.preset,
  };
}

function readInputDetailsBlock(input: unknown): DetailsOutputBlock {
  if (isRecord(input)) {
    return {
      title: input.title === undefined ? "Details" : String(input.title),
      content: input.content ?? "",
      icon: typeof input.icon === "string" ? input.icon : undefined,
    };
  }

  return {
    title: "Details",
    content: input,
  };
}

async function resolveDetailsField<Input>(
  field: DetailsOutputStaticContent | DetailsOutputFieldResolver<Input> | DetailsOutputIcon | undefined,
  input: Input,
  context: NodeContext,
  fallback: unknown,
): Promise<unknown> {
  if (typeof field === "function") {
    return field(input, context);
  }

  return field === undefined ? fallback : field;
}

function createDetailsOutputPayload(details: ResolvedDetailsOutputBlock): DetailsOutputPayload {
  const item = createOutputItem({
    title: details.title,
    content: details.content,
    icon: details.icon,
    iconPreset: details.iconPreset,
    contentType: details.contentType,
    collapsed: true,
  });

  return {
    errCode: 0,
    errMessage: "",
    items: [item],
  };
}

export function resolveDetailsOutputIcon(icon: unknown): {
  value: string;
  preset?: DetailsOutputIconPreset;
} {
  const raw = typeof icon === "string" ? icon.trim() : "";
  if (raw === "") {
    return { value: DETAILS_OUTPUT_ICON_PRESETS.info, preset: "info" };
  }

  if (isDetailsOutputIconPreset(raw)) {
    return { value: DETAILS_OUTPUT_ICON_PRESETS[raw], preset: raw };
  }

  return { value: raw };
}

function isDetailsOutputIconPreset(value: string): value is DetailsOutputIconPreset {
  return Object.hasOwn(DETAILS_OUTPUT_ICON_PRESETS, value);
}

let outputItemId = 0;

export function createOutputItem(input: WorkflowOutputItemInput): WorkflowOutputItem {
  const resolvedIcon = resolveOutputItemIcon(input);

  return {
    id: normalizeOutputItemId(input.id),
    title: stringifyDetailsValue(input.title).trim() || "Output",
    content: input.content,
    icon: resolvedIcon.value,
    iconPreset: resolvedIcon.preset,
    contentType: isOutputContentType(input.contentType)
      ? input.contentType
      : inferOutputContentType(input.content),
    display: input.display,
    collapsed: input.collapsed,
    metadata: input.metadata,
  };
}

function resolveOutputItemIcon(input: WorkflowOutputItemInput): {
  value?: string;
  preset?: DetailsOutputIconPreset;
} {
  if (input.iconPreset !== undefined) {
    return {
      value: input.icon ?? DETAILS_OUTPUT_ICON_PRESETS[input.iconPreset],
      preset: input.iconPreset,
    };
  }

  if (input.icon === undefined || String(input.icon).trim() === "") {
    return {};
  }

  return resolveDetailsOutputIcon(input.icon);
}

export function createOutputPayload(
  input: {
    items?: WorkflowOutputItemInput[] | WorkflowOutputItem[];
    errCode?: number;
    errMessage?: string;
  } & Record<string, unknown> = {},
): WorkflowOutputPayload {
  const { items = [], errCode = 0, errMessage = "", ...rest } = input;

  return {
    errCode,
    errMessage,
    items: items.map((item) => isWorkflowOutputItem(item) ? item : createOutputItem(item)),
    ...rest,
  };
}

export function addOutputItem<Payload extends WorkflowOutputPayload>(
  payload: Payload,
  item: WorkflowOutputItemInput | WorkflowOutputItem,
): Payload {
  return {
    ...payload,
    items: [
      ...payload.items,
      isWorkflowOutputItem(item) ? item : createOutputItem(item),
    ],
  };
}

export function createOutputItemChunk(
  chunk:
    | { type: "output_item_start"; item: WorkflowOutputItemInput }
    | { type: "output_item_delta"; itemId: string; delta: unknown; item?: Partial<WorkflowOutputItemInput> }
    | { type: "output_item_end"; itemId: string },
): OutputItemStreamChunk {
  return chunk;
}

export function createOutputStreamAccumulator(chunks: OutputStreamChunk[]): OutputStreamAccumulator {
  const items: WorkflowOutputItem[] = [];
  const itemsById = new Map<string, WorkflowOutputItem>();
  const textParts: string[] = [];
  let defaultMarkdownItemId: string | undefined;

  const upsertItem = (item: WorkflowOutputItem): void => {
    const existingIndex = items.findIndex((candidate) => candidate.id === item.id);
    if (existingIndex >= 0) {
      items[existingIndex] = item;
    } else {
      items.push(item);
    }
    itemsById.set(item.id, item);
  };

  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      textParts.push(chunk);
      if (defaultMarkdownItemId === undefined) {
        const item = createOutputItem({
          title: "Output",
          content: "",
          contentType: "markdown",
          collapsed: false,
        });
        defaultMarkdownItemId = item.id;
        upsertItem(item);
      }
      const existing = itemsById.get(defaultMarkdownItemId);
      if (existing !== undefined) {
        upsertItem({
          ...existing,
          content: `${stringifyStreamContent(existing.content)}${chunk}`,
        });
      }
      continue;
    }

    if (chunk.type === "output_item_start") {
      upsertItem(createOutputItem(chunk.item));
      continue;
    }

    if (chunk.type === "output_item_delta") {
      const existing = itemsById.get(chunk.itemId);
      if (existing === undefined) {
        continue;
      }

      upsertItem({
        ...existing,
        content: mergeOutputItemContent(existing.content, chunk.delta),
        ...normalizeOutputItemPatch(chunk.item),
      });
    }
  }

  return {
    text: textParts.join(""),
    items,
    chunks,
  };
}

function normalizeOutputItemPatch(
  patch: Partial<WorkflowOutputItemInput> | undefined,
): Partial<WorkflowOutputItem> {
  if (patch === undefined) {
    return {};
  }

  const normalized: Partial<WorkflowOutputItem> = {};
  if (patch.title !== undefined) normalized.title = patch.title;
  if (patch.icon !== undefined) normalized.icon = resolveDetailsOutputIcon(patch.icon).value;
  if (patch.iconPreset !== undefined) normalized.iconPreset = patch.iconPreset;
  if (isOutputContentType(patch.contentType)) normalized.contentType = patch.contentType;
  if (patch.display !== undefined) normalized.display = patch.display;
  if (patch.collapsed !== undefined) normalized.collapsed = patch.collapsed;
  if (patch.metadata !== undefined) normalized.metadata = patch.metadata;
  return normalized;
}

export function isWorkflowOutputPayload(value: unknown): value is WorkflowOutputPayload {
  return isRecord(value) && Array.isArray(value.items);
}

export function isOutputItemStreamChunk(value: unknown): value is OutputItemStreamChunk {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "output_item_start") {
    return isRecord(value.item) &&
      typeof value.item.title === "string" &&
      Object.hasOwn(value.item, "content") &&
      (value.item.id === undefined || typeof value.item.id === "string");
  }

  if (value.type === "output_item_delta") {
    return typeof value.itemId === "string" &&
      value.itemId.trim() !== "" &&
      Object.hasOwn(value, "delta") &&
      (value.item === undefined || isRecord(value.item));
  }

  if (value.type === "output_item_end") {
    return typeof value.itemId === "string" && value.itemId.trim() !== "";
  }

  return false;
}

export function isOutputContentType(value: unknown): value is WorkflowOutputContentType {
  return value === "markdown" ||
    value === "text" ||
    value === "json" ||
    value === "audio" ||
    value === "video";
}

function isWorkflowOutputItem(value: unknown): value is WorkflowOutputItem {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    Object.hasOwn(value, "content")
  );
}

function normalizeOutputItemId(value: string | undefined): string {
  const normalized = value?.trim();
  if (normalized !== undefined && normalized !== "") {
    return normalized;
  }

  outputItemId += 1;
  return `output-item-${Date.now().toString(36)}-${outputItemId.toString(36)}`;
}

function inferOutputContentType(value: unknown): WorkflowOutputContentType {
  if (typeof value === "object" && value !== null) {
    return "json";
  }

  return "markdown";
}

function mergeOutputItemContent(current: unknown, delta: unknown): unknown {
  if (typeof current === "string" || typeof delta === "string") {
    return `${stringifyStreamContent(current)}${stringifyStreamContent(delta)}`;
  }

  if (Array.isArray(current) && Array.isArray(delta)) {
    return [...current, ...delta];
  }

  if (isRecord(current) && isRecord(delta)) {
    return {
      ...current,
      ...delta,
    };
  }

  return delta;
}

function stringifyStreamContent(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : stringifyDetailsValue(value);
}

function stringifyDetailsValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
