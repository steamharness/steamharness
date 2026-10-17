export const OPENAI_RESPONSE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const OPENAI_EPHEMERAL_BACKGROUND_RETENTION_MS = 10 * 60 * 1000;
export const OPENAI_DEFAULT_PAGE_LIMIT = 20;
export const OPENAI_MAX_PAGE_LIMIT = 100;
export const OPENAI_MAX_CONVERSATION_ITEMS_PER_REQUEST = 20;
export const OPENAI_PROJECT_KEY_PREFIX = "wfpk_";

const RESPONSE_CREATE_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "temperature",
  "top_p",
  "max_output_tokens",
  "text",
  "include",
  "store",
  "stream",
  "background",
  "previous_response_id",
  "conversation",
  "metadata",
]);
const RESPONSE_TEXT_FIELDS = new Set(["format", "verbosity"]);
const RESPONSE_TEXT_FORMAT_FIELDS = new Set(["type"]);
const SUPPORTED_RESPONSE_INCLUDES = new Set(["reasoning.encrypted_content"]);
const CONVERSATION_CREATE_FIELDS = new Set(["items", "metadata"]);
const CONVERSATION_UPDATE_FIELDS = new Set(["metadata"]);
const CONVERSATION_ITEMS_FIELDS = new Set(["items"]);
const MESSAGE_FIELDS = new Set(["id", "type", "role", "content", "status"]);
const CONTENT_FIELDS = new Set(["type", "text", "image_url"]);
const IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/iu;
const OPENAI_ID_PATTERN = /^(resp|conv|msg)_[a-zA-Z0-9_-]+$/u;

export type OpenAIResponseStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "incomplete";

export type OpenAIIncompleteReason = "max_output_tokens" | "content_filter";

export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "server_error";

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: OpenAIErrorType;
    param: string | null;
    code: string | null;
  };
}

export class OpenAIProtocolError extends Error {
  readonly status: number;
  readonly type: OpenAIErrorType;
  readonly param: string | null;
  readonly code: string | null;

  constructor(options: {
    message: string;
    status?: number;
    type?: OpenAIErrorType;
    param?: string | null;
    code?: string | null;
  }) {
    super(options.message);
    this.name = "OpenAIProtocolError";
    this.status = options.status ?? 400;
    this.type = options.type ?? "invalid_request_error";
    this.param = options.param ?? null;
    this.code = options.code ?? null;
  }
}

export interface OpenAIInputTextPart {
  type: "input_text";
  text: string;
}

export interface OpenAIOutputTextPart {
  type: "output_text";
  text: string;
  annotations?: unknown[];
  logprobs?: unknown[];
}

export interface OpenAIInputImagePart {
  type: "input_image";
  image_url: string;
}

export type OpenAIMessageContentPart =
  | OpenAIInputTextPart
  | OpenAIOutputTextPart
  | OpenAIInputImagePart;

export type OpenAIMessageRole = "user" | "assistant" | "system" | "developer";

export interface OpenAIMessageItem {
  id?: string;
  type: "message";
  role: OpenAIMessageRole;
  content: OpenAIMessageContentPart[];
  status?: "in_progress" | "completed" | "incomplete";
}

export type OpenAIResponseInput = string | OpenAIMessageItem[];
export type OpenAIMetadata = Record<string, string>;
export type OpenAITextVerbosity = "low" | "medium" | "high";
export type OpenAIResponseInclude = "reasoning.encrypted_content";

export interface OpenAIResponseTextConfig {
  format: { type: "text" };
  verbosity?: OpenAITextVerbosity;
}

export interface OpenAIResponseCreateRequest {
  model: string;
  input: OpenAIResponseInput;
  instructions?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  text: OpenAIResponseTextConfig;
  include: OpenAIResponseInclude[];
  store: boolean;
  stream: boolean;
  background: boolean;
  previous_response_id?: string;
  conversation?: string;
  metadata: OpenAIMetadata;
}

export interface OpenAIResponseUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export interface OpenAIResponseResource {
  id: string;
  object: "response";
  created_at: number;
  completed_at: number | null;
  status: OpenAIResponseStatus;
  background: boolean;
  error: null | { code: string; message: string };
  incomplete_details: null | { reason: OpenAIIncompleteReason };
  instructions: string | null;
  max_output_tokens: number | null;
  max_tool_calls: null;
  model: string;
  output: OpenAIMessageItem[];
  parallel_tool_calls: false;
  previous_response_id: string | null;
  conversation: null | { id: string };
  metadata: OpenAIMetadata;
  store: boolean;
  temperature: number | null;
  top_p: number | null;
  tools: [];
  tool_choice: "auto";
  reasoning: { effort: null; summary: null };
  text: OpenAIResponseTextConfig;
  truncation: "disabled";
  user: null;
  usage: OpenAIResponseUsage | null;
}

export interface OpenAIConversationResource {
  id: string;
  object: "conversation";
  created_at: number;
  metadata: OpenAIMetadata;
}

export interface OpenAIConversationCreateRequest {
  items: OpenAIMessageItem[];
  metadata: OpenAIMetadata;
}

export interface OpenAIConversationUpdateRequest {
  metadata: OpenAIMetadata;
}

export interface OpenAIConversationItemsRequest {
  items: OpenAIMessageItem[];
}

export interface OpenAIDeletedResource {
  id: string;
  object: "response.deleted" | "conversation.deleted";
  deleted: true;
}

export interface OpenAIList<T> {
  object: "list";
  data: T[];
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
}

export interface OpenAIModelResource {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface OpenAIConversationHostInput {
  kind: "openai.responses";
  requestId: string;
  responseId: string;
  projectId: string;
  model: string;
  instructions?: string;
  messages: OpenAIMessageItem[];
  settings: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    verbosity?: OpenAITextVerbosity;
  };
  apiConversationId?: string;
}

export interface OpenAIProjectKeyRecord {
  id: string;
  projectId: string;
  ownerId: string;
  prefix: string;
  secretHash: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface OpenAIAccessKeySummary {
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface OpenAIAccessInfo {
  adapterEnabled: boolean;
  serviceAvailable: boolean;
  baseUrl: string;
  responsesUrl: string;
  key: OpenAIAccessKeySummary | null;
  models: string[];
  error?: {
    code: string;
    message: string;
  };
}

export interface OpenAIAccessSecret extends OpenAIAccessInfo {
  secret: string;
}

export interface OpenAIStoredResponse {
  namespace: string;
  projectId: string;
  runId?: string;
  response: OpenAIResponseResource;
  inputItems: OpenAIMessageItem[];
  imageReferences?: OpenAIStoredImageReference[];
  newImageFileIds?: string[];
  expiresAt?: string;
}

export type OpenAIImageMimeType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface OpenAIStoredImageReference {
  itemId: string;
  contentIndex: number;
  fileId: string;
  mimeType: OpenAIImageMimeType;
}

export interface OpenAIStoreDeleteResult {
  deleted: boolean;
  orphanedFileIds: string[];
}

export interface OpenAIStoreCleanupResult {
  deletedResponses: number;
  orphanedFileIds: string[];
}

export interface OpenAIStoredConversation {
  namespace: string;
  projectId: string;
  conversation: OpenAIConversationResource;
}

export interface OpenAIResponsesStore {
  getActiveProjectKey(ownerId: string, projectId: string): Promise<OpenAIProjectKeyRecord | undefined>;
  getProjectKeyByHash(secretHash: string): Promise<OpenAIProjectKeyRecord | undefined>;
  createProjectKey(record: OpenAIProjectKeyRecord): Promise<boolean>;
  replaceActiveProjectKey(record: OpenAIProjectKeyRecord, revokedAt: string): Promise<void>;
  revokeProjectKey(id: string, revokedAt: string): Promise<boolean>;
  touchProjectKey(id: string, usedAt: string): Promise<void>;
  getResponse(namespace: string, id: string): Promise<OpenAIStoredResponse | undefined>;
  createResponse(record: OpenAIStoredResponse): Promise<boolean>;
  transitionResponse(
    record: OpenAIStoredResponse,
    expectedStatuses: readonly OpenAIResponseStatus[],
  ): Promise<boolean>;
  transitionResponseWithConversationItems(
    record: OpenAIStoredResponse,
    expectedStatuses: readonly OpenAIResponseStatus[],
    conversationId: string,
    items: OpenAIMessageItem[],
    imageReferences?: OpenAIStoredImageReference[],
    newImageFileIds?: string[],
  ): Promise<boolean>;
  deleteResponse(namespace: string, id: string): Promise<OpenAIStoreDeleteResult>;
  getConversation(namespace: string, id: string): Promise<OpenAIStoredConversation | undefined>;
  createConversationWithItems(
    record: OpenAIStoredConversation,
    items: OpenAIMessageItem[],
    imageReferences?: OpenAIStoredImageReference[],
    newImageFileIds?: string[],
  ): Promise<boolean>;
  updateConversationMetadata(namespace: string, id: string, metadata: OpenAIMetadata): Promise<boolean>;
  deleteConversation(namespace: string, id: string): Promise<OpenAIStoreDeleteResult>;
  listConversationItems(namespace: string, conversationId: string): Promise<OpenAIMessageItem[]>;
  listConversationImageReferences(namespace: string, conversationId: string): Promise<OpenAIStoredImageReference[]>;
  appendConversationItems(
    namespace: string,
    conversationId: string,
    items: OpenAIMessageItem[],
    imageReferences?: OpenAIStoredImageReference[],
    newImageFileIds?: string[],
  ): Promise<void>;
  getConversationItem(namespace: string, conversationId: string, itemId: string): Promise<OpenAIMessageItem | undefined>;
  deleteConversationItem(namespace: string, conversationId: string, itemId: string): Promise<OpenAIStoreDeleteResult>;
  cleanupExpired(now: string): Promise<OpenAIStoreCleanupResult>;
}

export type OpenAITextStreamEvent =
  | { type: "response.created" | "response.in_progress" | "response.completed" | "response.incomplete" | "response.failed"; sequence_number: number; response: OpenAIResponseResource }
  | { type: "response.output_item.added" | "response.output_item.done"; sequence_number: number; output_index: 0; item: OpenAIMessageItem }
  | { type: "response.content_part.added" | "response.content_part.done"; sequence_number: number; item_id: string; output_index: 0; content_index: 0; part: OpenAIOutputTextPart }
  | { type: "response.output_text.delta"; sequence_number: number; item_id: string; output_index: 0; content_index: 0; delta: string; logprobs: [] }
  | { type: "response.output_text.done"; sequence_number: number; item_id: string; output_index: 0; content_index: 0; text: string; logprobs: [] }
  | { type: "error"; sequence_number: number; message: string; param: string | null; code: string | null };

export interface OpenAIInternalRunnerRequest {
  protocolVersion: 1;
  action: "run";
  executionId: string;
  projectPath: string;
  hostInput: OpenAIConversationHostInput;
}

export type OpenAIInternalRunnerFrame =
  | { type: "ready"; executionId: string }
  | { type: "text-delta"; executionId: string; delta: string }
  | { type: "completed"; executionId: string; outputText: string; outputItemId: string; usage: OpenAIResponseUsage; report: unknown; finishReason?: string; providerMetadata?: unknown }
  | { type: "failed"; executionId: string; error: { message: string; code?: string }; report?: unknown }
  | { type: "cancelled"; executionId: string; report?: unknown };

export function createOpenAIErrorBody(error: unknown): OpenAIErrorBody {
  const normalized = error instanceof OpenAIProtocolError
    ? error
    : new OpenAIProtocolError({
        message: error instanceof Error ? error.message : "Internal server error.",
        status: 500,
        type: "server_error",
        code: "server_error",
      });
  return {
    error: {
      message: normalized.message,
      type: normalized.type,
      param: normalized.param,
      code: normalized.code,
    },
  };
}

export function parseOpenAIResponseCreateRequest(value: unknown): OpenAIResponseCreateRequest {
  const body = requireRecord(value, "request body");
  rejectUnknownFields(body, RESPONSE_CREATE_FIELDS, "request body");
  const model = requireNonEmptyString(body.model, "model");
  const input = parseResponseInput(body.input);
  const instructions = optionalContentString(body.instructions, "instructions");
  const temperature = optionalNumber(body.temperature, "temperature", { min: 0, max: 2 });
  const topP = optionalNumber(body.top_p, "top_p", { min: 0, max: 1 });
  const maxOutputTokens = optionalInteger(body.max_output_tokens, "max_output_tokens", 1);
  const text = parseResponseTextConfig(body.text);
  const include = parseResponseIncludes(body.include);
  const store = optionalBoolean(body.store, "store") ?? true;
  const stream = optionalBoolean(body.stream, "stream") ?? false;
  const background = optionalBoolean(body.background, "background") ?? false;
  const previousResponseId = optionalOpenAIId(body.previous_response_id, "previous_response_id", "resp");
  const conversation = parseConversationReference(body.conversation);
  const metadata = parseMetadata(body.metadata);

  if (conversation && previousResponseId) {
    invalid("conversation cannot be used with previous_response_id.", "conversation", "mutually_exclusive");
  }
  if (stream && background) {
    invalid("background streaming is not supported.", "stream", "unsupported_combination");
  }

  return {
    model,
    input,
    instructions,
    temperature,
    top_p: topP,
    max_output_tokens: maxOutputTokens,
    text,
    include,
    store,
    stream,
    background,
    previous_response_id: previousResponseId,
    conversation,
    metadata,
  };
}

export function parseOpenAIConversationCreateRequest(value: unknown): OpenAIConversationCreateRequest {
  const body = value === undefined || value === null ? {} : requireRecord(value, "request body");
  rejectUnknownFields(body, CONVERSATION_CREATE_FIELDS, "request body");
  return {
    items: body.items === undefined || body.items === null
      ? []
      : parseConversationMessageItems(body.items, "items", OPENAI_MAX_CONVERSATION_ITEMS_PER_REQUEST),
    metadata: parseMetadata(body.metadata),
  };
}

export function parseOpenAIConversationUpdateRequest(value: unknown): OpenAIConversationUpdateRequest {
  const body = requireRecord(value, "request body");
  rejectUnknownFields(body, CONVERSATION_UPDATE_FIELDS, "request body");
  if (body.metadata === undefined) {
    invalid("metadata is required.", "metadata", "missing_required_parameter");
  }
  return { metadata: parseMetadata(body.metadata) };
}

export function parseOpenAIConversationItemsRequest(value: unknown): OpenAIConversationItemsRequest {
  const body = requireRecord(value, "request body");
  rejectUnknownFields(body, CONVERSATION_ITEMS_FIELDS, "request body");
  return {
    items: parseConversationMessageItems(body.items, "items", OPENAI_MAX_CONVERSATION_ITEMS_PER_REQUEST),
  };
}

export function parseOpenAIMessageItems(value: unknown, param = "items"): OpenAIMessageItem[] {
  const items = parseConversationMessageItems(value, param);
  if (!items.some((item) => item.role === "user" && item.content.some(isMeaningfulUserPart))) {
    invalid(`${param} must contain user text or an image.`, param, "missing_user_input");
  }
  return items;
}

export function parseOpenAIConversationMessageItems(value: unknown, param = "items"): OpenAIMessageItem[] {
  return parseConversationMessageItems(value, param);
}

export function assertUniqueOpenAIMessageItemIds(
  items: readonly OpenAIMessageItem[],
  param = "items",
  reservedIds: Iterable<string> = [],
): void {
  const seen = new Set(reservedIds);
  for (const [index, item] of items.entries()) {
    if (!item.id) continue;
    if (seen.has(item.id)) {
      invalid(
        `Duplicate message item ID "${item.id}".`,
        `${param}[${index}].id`,
        "duplicate_item_id",
      );
    }
    seen.add(item.id);
  }
}

export function normalizeResponseInputItems(input: OpenAIResponseInput): OpenAIMessageItem[] {
  return typeof input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }]
    : input;
}

export function parseOpenAIMetadata(value: unknown): OpenAIMetadata {
  return parseMetadata(value);
}

export function parseOpenAIPageQuery(value: Record<string, unknown>): {
  after?: string;
  limit: number;
  order: "asc" | "desc";
} {
  const allowed = new Set(["after", "limit", "order"]);
  rejectUnknownFields(value, allowed, "query");
  const after = optionalString(value.after, "after");
  const limit = value.limit === undefined
    ? OPENAI_DEFAULT_PAGE_LIMIT
    : optionalInteger(normalizeQueryNumber(value.limit), "limit", 1, OPENAI_MAX_PAGE_LIMIT)!;
  const orderValue = value.order ?? "desc";
  if (orderValue !== "asc" && orderValue !== "desc") {
    invalid("order must be asc or desc.", "order", "invalid_value");
  }
  return { after, limit, order: orderValue };
}

export function paginateOpenAIResources<T extends { id?: string }>(
  values: readonly T[],
  options: { after?: string; limit?: number; order?: "asc" | "desc" } = {},
): OpenAIList<T> {
  const ordered = options.order === "asc" ? [...values] : [...values].reverse();
  const afterIndex = options.after
    ? ordered.findIndex((item) => item.id === options.after)
    : -1;
  if (options.after && afterIndex < 0) {
    invalid("The after cursor is invalid or no longer available.", "after", "invalid_cursor");
  }
  const start = afterIndex >= 0 ? afterIndex + 1 : 0;
  const limit = Math.min(OPENAI_MAX_PAGE_LIMIT, Math.max(1, options.limit ?? OPENAI_DEFAULT_PAGE_LIMIT));
  const data = ordered.slice(start, start + limit);
  return {
    object: "list",
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: start + data.length < ordered.length,
  };
}

export function createOpenAIResourceId(prefix: "resp" | "conv" | "msg" | "req"): string {
  return `${prefix}_${randomToken(18)}`;
}

export function createOpenAIProjectKey(): { token: string; prefix: string } {
  const token = `${OPENAI_PROJECT_KEY_PREFIX}${randomToken(32)}`;
  return { token, prefix: token.slice(0, OPENAI_PROJECT_KEY_PREFIX.length + 8) };
}

export function assertOpenAIProjectKey(value: string): string {
  const normalized = value.trim();
  if (!normalized.startsWith(OPENAI_PROJECT_KEY_PREFIX) || normalized.length < 32) {
    throw new OpenAIProtocolError({
      message: "Incorrect API key provided.",
      status: 401,
      type: "authentication_error",
      code: "invalid_api_key",
    });
  }
  return normalized;
}

export async function hashOpenAIProjectKey(value: string): Promise<string> {
  const token = assertOpenAIProjectKey(value);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Secure hashing is unavailable.");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function extractOpenAIBearerToken(value: string | undefined): string {
  if (!value) {
    throw new OpenAIProtocolError({
      message: "Missing bearer authentication.",
      status: 401,
      type: "authentication_error",
      code: "missing_api_key",
    });
  }
  const match = /^Bearer[ \t]+([^\s,]+)$/iu.exec(value.trim());
  if (!match) {
    throw new OpenAIProtocolError({
      message: "Authorization must use a single Bearer API key.",
      status: 401,
      type: "authentication_error",
      code: "invalid_api_key",
    });
  }
  return assertOpenAIProjectKey(match[1]!);
}

export function createOpenAIResponseResource(options: {
  id?: string;
  createdAt?: number;
  request: OpenAIResponseCreateRequest;
  status?: OpenAIResponseStatus;
  outputText?: string;
  outputItemId?: string;
  usage?: Partial<OpenAIResponseUsage>;
  error?: { code: string; message: string } | null;
  incompleteReason?: OpenAIIncompleteReason;
}): OpenAIResponseResource {
  const output = options.outputText === undefined
    ? []
    : [{
        id: options.outputItemId ?? createOpenAIResourceId("msg"),
        type: "message" as const,
        status: options.status === "completed"
          ? "completed" as const
          : options.status === "incomplete"
            ? "incomplete" as const
            : "in_progress" as const,
        role: "assistant" as const,
        content: [{
          type: "output_text" as const,
          text: options.outputText,
          annotations: [],
          logprobs: [],
        }],
      }];
  const usage = options.usage ? normalizeUsage(options.usage) : null;
  return {
    id: options.id ?? createOpenAIResourceId("resp"),
    object: "response",
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    completed_at: options.status === "completed" ? Math.floor(Date.now() / 1000) : null,
    status: options.status ?? "in_progress",
    background: options.request.background,
    error: options.error ?? null,
    incomplete_details: options.incompleteReason ? { reason: options.incompleteReason } : null,
    instructions: options.request.instructions ?? null,
    max_output_tokens: options.request.max_output_tokens ?? null,
    max_tool_calls: null,
    model: options.request.model,
    output,
    parallel_tool_calls: false,
    previous_response_id: options.request.previous_response_id ?? null,
    conversation: options.request.conversation ? { id: options.request.conversation } : null,
    metadata: options.request.metadata,
    store: options.request.store,
    temperature: options.request.temperature ?? null,
    top_p: options.request.top_p ?? null,
    tools: [],
    tool_choice: "auto",
    reasoning: { effort: null, summary: null },
    text: options.request.text,
    truncation: "disabled",
    user: null,
    usage,
  };
}

export function mapOpenAIFinishReasonToIncompleteReason(
  finishReason: string | undefined,
): OpenAIIncompleteReason | undefined {
  switch (finishReason?.trim().toLowerCase()) {
    case "length":
    case "max_tokens":
    case "max_output_tokens":
      return "max_output_tokens";
    case "content-filter":
    case "content_filter":
      return "content_filter";
    default:
      return undefined;
  }
}

export function createOpenAIConversationResource(options: {
  id?: string;
  createdAt?: number;
  metadata?: OpenAIMetadata;
} = {}): OpenAIConversationResource {
  return {
    id: options.id ?? createOpenAIResourceId("conv"),
    object: "conversation",
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    metadata: options.metadata ?? {},
  };
}

export function createOpenAIDeletedResource(
  id: string,
  kind: "response" | "conversation",
): OpenAIDeletedResource {
  return {
    id,
    object: `${kind}.deleted`,
    deleted: true,
  };
}

export function createOpenAIModelResource(id: string, ownedBy = "steamharness"): OpenAIModelResource {
  return {
    id: requireNonEmptyString(id, "model"),
    object: "model",
    created: 0,
    owned_by: ownedBy,
  };
}

export function extractOpenAIOutputText(response: OpenAIResponseResource): string {
  return response.output
    .flatMap((item) => item.content)
    .filter((part): part is OpenAIOutputTextPart => part.type === "output_text")
    .map((part) => part.text)
    .join("");
}

export function formatOpenAISseEvent(event: { type: string; [key: string]: unknown }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createOpenAITextStreamEventFactory(options: {
  response: OpenAIResponseResource;
  outputItemId?: string;
}): {
  created(): OpenAITextStreamEvent[];
  delta(value: string): OpenAITextStreamEvent;
  completed(response: OpenAIResponseResource, text: string): OpenAITextStreamEvent[];
  incomplete(response: OpenAIResponseResource, text: string): OpenAITextStreamEvent[];
  failed(response: OpenAIResponseResource): OpenAITextStreamEvent[];
  error(error: unknown): OpenAITextStreamEvent;
} {
  const outputItemId = options.outputItemId ?? createOpenAIResourceId("msg");
  let sequenceNumber = 0;
  const next = () => sequenceNumber++;
  const emptyItem: OpenAIMessageItem = {
    id: outputItemId,
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [],
  };
  const emptyPart: OpenAIOutputTextPart = { type: "output_text", text: "", annotations: [], logprobs: [] };
  const terminalEvents = (
    response: OpenAIResponseResource,
    text: string,
    terminalType: "response.completed" | "response.incomplete",
  ): OpenAITextStreamEvent[] => {
    const item = response.output[0] ?? {
      ...emptyItem,
      status: terminalType === "response.completed" ? "completed" as const : "incomplete" as const,
      content: [{ ...emptyPart, text }],
    };
    const part = item.content[0];
    if (!part || part.type !== "output_text") throw new Error("Terminal response is missing output_text.");
    return [
      { type: "response.output_text.done", sequence_number: next(), item_id: outputItemId, output_index: 0, content_index: 0, text, logprobs: [] },
      { type: "response.content_part.done", sequence_number: next(), item_id: outputItemId, output_index: 0, content_index: 0, part },
      { type: "response.output_item.done", sequence_number: next(), output_index: 0, item },
      { type: terminalType, sequence_number: next(), response },
    ];
  };
  return {
    created() {
      return [
        { type: "response.created", sequence_number: next(), response: options.response },
        { type: "response.in_progress", sequence_number: next(), response: options.response },
        { type: "response.output_item.added", sequence_number: next(), output_index: 0, item: emptyItem },
        { type: "response.content_part.added", sequence_number: next(), item_id: outputItemId, output_index: 0, content_index: 0, part: emptyPart },
      ];
    },
    delta(value) {
      return {
        type: "response.output_text.delta",
        sequence_number: next(),
        item_id: outputItemId,
        output_index: 0,
        content_index: 0,
        delta: value,
        logprobs: [],
      };
    },
    completed(response, text) {
      return terminalEvents(response, text, "response.completed");
    },
    incomplete(response, text) {
      return terminalEvents(response, text, "response.incomplete");
    },
    failed(response) {
      return [{ type: "response.failed", sequence_number: next(), response }];
    },
    error(error) {
      const body = createOpenAIErrorBody(error).error;
      return {
        type: "error",
        sequence_number: next(),
        message: body.message,
        param: body.param,
        code: body.code,
      };
    },
  };
}

export function assertOpenAIStatusTransition(
  current: OpenAIResponseStatus,
  next: OpenAIResponseStatus,
): void {
  const allowed: Record<OpenAIResponseStatus, readonly OpenAIResponseStatus[]> = {
    queued: ["in_progress", "cancelled", "failed"],
    in_progress: ["completed", "cancelled", "failed", "incomplete"],
    completed: [],
    failed: [],
    cancelled: [],
    incomplete: [],
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`Invalid OpenAI response status transition: ${current} -> ${next}.`);
  }
}

export function isOpenAITerminalStatus(status: OpenAIResponseStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "incomplete";
}

export function isOpenAIConversationHostInput(value: unknown): value is OpenAIConversationHostInput {
  if (!isRecord(value) || value.kind !== "openai.responses") return false;
  return typeof value.requestId === "string"
    && typeof value.responseId === "string"
    && typeof value.projectId === "string"
    && typeof value.model === "string"
    && Array.isArray(value.messages)
    && isRecord(value.settings);
}

function parseResponseInput(value: unknown): OpenAIResponseInput {
  if (typeof value === "string") {
    if (value.trim() === "") invalid("input must not be empty.", "input", "invalid_value");
    return value;
  }
  return parseOpenAIMessageItems(value, "input");
}

function parseConversationMessageItems(value: unknown, param: string, maxItems?: number): OpenAIMessageItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid(`${param} must be a non-empty array.`, param, "invalid_type");
  }
  if (maxItems !== undefined && value.length > maxItems) {
    invalid(`${param} may contain at most ${maxItems} items.`, param, "too_many_items");
  }
  const items = value.map((item, index) => parseMessageItem(item, `${param}[${index}]`));
  assertUniqueOpenAIMessageItemIds(items, param);
  return items;
}

function parseMessageItem(value: unknown, param: string): OpenAIMessageItem {
  const item = requireRecord(value, param);
  rejectUnknownFields(item, MESSAGE_FIELDS, param);
  if (item.type !== undefined && item.type !== "message") {
    invalid(`${param}.type must be message.`, `${param}.type`, "unsupported_item_type");
  }
  if (
    item.role !== "user"
    && item.role !== "assistant"
    && item.role !== "system"
    && item.role !== "developer"
  ) {
    invalid(`${param}.role must be user, assistant, system, or developer.`, `${param}.role`, "unsupported_role");
  }
  const content = parseMessageContent(item.content, item.role, `${param}.content`);
  const id = item.id === undefined ? undefined : optionalOpenAIId(item.id, `${param}.id`, "msg");
  const status = item.status;
  if (status !== undefined && status !== "in_progress" && status !== "completed" && status !== "incomplete") {
    invalid(`${param}.status is invalid.`, `${param}.status`, "invalid_value");
  }
  return { id, type: "message", role: item.role, content, status };
}

function parseMessageContent(
  value: unknown,
  role: OpenAIMessageRole,
  param: string,
): OpenAIMessageContentPart[] {
  if (typeof value === "string") {
    if (value.trim() === "") invalid(`${param} must not be empty.`, param, "invalid_value");
    return [{ type: role === "assistant" ? "output_text" : "input_text", text: value }];
  }
  if (!Array.isArray(value) || value.length === 0) {
    invalid(`${param} must be a string or non-empty array.`, param, "invalid_type");
  }
  return value.map((part, index) => parseContentPart(part, role, `${param}[${index}]`));
}

function parseContentPart(
  value: unknown,
  role: OpenAIMessageRole,
  param: string,
): OpenAIMessageContentPart {
  const part = requireRecord(value, param);
  rejectUnknownFields(part, CONTENT_FIELDS, param);
  if (part.type === "input_text" && role !== "assistant") {
    return { type: "input_text", text: requireContentString(part.text, `${param}.text`) };
  }
  if ((part.type === "output_text" || part.type === "input_text") && role === "assistant") {
    return { type: "output_text", text: requireContentString(part.text, `${param}.text`) };
  }
  if (part.type === "input_image" && role === "user") {
    const imageUrl = requireNonEmptyString(part.image_url, `${param}.image_url`);
    assertSupportedImageUrl(imageUrl, `${param}.image_url`);
    return { type: "input_image", image_url: imageUrl };
  }
  invalid(`${param}.type is not supported for role ${role}.`, `${param}.type`, "unsupported_content_type");
}

function parseResponseTextConfig(value: unknown): OpenAIResponseTextConfig {
  if (value === undefined || value === null) return { format: { type: "text" } };
  const text = requireRecord(value, "text");
  rejectUnknownFields(text, RESPONSE_TEXT_FIELDS, "text");

  if (text.format !== undefined && text.format !== null) {
    const format = requireRecord(text.format, "text.format");
    rejectUnknownFields(format, RESPONSE_TEXT_FORMAT_FIELDS, "text.format");
    if (format.type !== "text") {
      invalid(
        "text.format.type only supports text in this version.",
        "text.format.type",
        "unsupported_text_format",
      );
    }
  }

  const verbosity = text.verbosity;
  if (
    verbosity !== undefined
    && verbosity !== null
    && verbosity !== "low"
    && verbosity !== "medium"
    && verbosity !== "high"
  ) {
    invalid("text.verbosity must be low, medium, or high.", "text.verbosity", "invalid_value");
  }
  return {
    format: { type: "text" },
    ...(verbosity === undefined || verbosity === null ? {} : { verbosity }),
  };
}

function parseResponseIncludes(value: unknown): OpenAIResponseInclude[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid("include must be an array.", "include", "invalid_type");
  const includes: OpenAIResponseInclude[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !SUPPORTED_RESPONSE_INCLUDES.has(item)) {
      invalid(`include[${index}] is not supported.`, `include[${index}]`, "unsupported_include");
    }
    const include = item as OpenAIResponseInclude;
    if (!includes.includes(include)) includes.push(include);
  }
  return includes;
}

function assertSupportedImageUrl(value: string, param: string): void {
  if (IMAGE_DATA_URL_PATTERN.test(value)) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(`${param} must be an HTTP(S) URL or supported image data URL.`, param, "invalid_image_url");
  }
  if (url!.protocol !== "http:" && url!.protocol !== "https:") {
    invalid(`${param} must use HTTP or HTTPS.`, param, "invalid_image_url");
  }
}

function parseConversationReference(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return optionalOpenAIId(value, "conversation", "conv");
  const record = requireRecord(value, "conversation");
  rejectUnknownFields(record, new Set(["id"]), "conversation");
  if (record.id === undefined || record.id === null) {
    invalid("conversation.id is required.", "conversation.id", "missing_required_parameter");
  }
  return optionalOpenAIId(record.id, "conversation.id", "conv");
}

function parseMetadata(value: unknown): OpenAIMetadata {
  if (value === undefined || value === null) return {};
  const record = requireRecord(value, "metadata");
  const entries = Object.entries(record);
  if (entries.length > 16) invalid("metadata may contain at most 16 entries.", "metadata", "too_many_entries");
  const output: OpenAIMetadata = {};
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > 64) invalid("metadata keys must be 1-64 characters.", "metadata", "invalid_key");
    if (typeof item !== "string" || item.length > 512) {
      invalid(`metadata.${key} must be a string of at most 512 characters.`, `metadata.${key}`, "invalid_value");
    }
    output[key] = item;
  }
  return output;
}

function normalizeUsage(value: Partial<OpenAIResponseUsage>): OpenAIResponseUsage {
  const inputTokens = nonNegativeInteger(value.input_tokens);
  const outputTokens = nonNegativeInteger(value.output_tokens);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: nonNegativeInteger(value.input_tokens_details?.cached_tokens) },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: nonNegativeInteger(value.output_tokens_details?.reasoning_tokens) },
    total_tokens: value.total_tokens === undefined
      ? inputTokens + outputTokens
      : nonNegativeInteger(value.total_tokens),
  };
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeQueryNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return /^\d+$/u.test(value) ? Number(value) : value;
}

function requireRecord(value: unknown, param: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${param} must be an object.`, param, "invalid_type");
  return value;
}

function requireNonEmptyString(value: unknown, param: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${param} must be a non-empty string.`, param, "invalid_type");
  }
  return value.trim();
}

function requireContentString(value: unknown, param: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${param} must be a non-empty string.`, param, "invalid_type");
  }
  return value;
}

function optionalContentString(value: unknown, param: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireContentString(value, param);
}

function optionalString(value: unknown, param: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireNonEmptyString(value, param);
}

function optionalBoolean(value: unknown, param: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") invalid(`${param} must be a boolean.`, param, "invalid_type");
  return value;
}

function optionalNumber(
  value: unknown,
  param: string,
  bounds: { min: number; max: number },
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < bounds.min || value > bounds.max) {
    invalid(`${param} must be between ${bounds.min} and ${bounds.max}.`, param, "invalid_value");
  }
  return value;
}

function optionalInteger(value: unknown, param: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${param} must be an integer between ${min} and ${max}.`, param, "invalid_value");
  }
  return value;
}

function optionalOpenAIId(value: unknown, param: string, prefix: "resp" | "conv" | "msg"): string | undefined {
  if (value === undefined || value === null) return undefined;
  const id = requireNonEmptyString(value, param);
  if (!OPENAI_ID_PATTERN.test(id) || !id.startsWith(`${prefix}_`)) {
    invalid(`${param} must be a valid ${prefix}_ ID.`, param, "invalid_id");
  }
  return id;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, param: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(`Unknown parameter: ${param}.${unknown}.`, `${param}.${unknown}`, "unknown_parameter");
}

function isMeaningfulUserPart(part: OpenAIMessageContentPart): boolean {
  return part.type === "input_image" || (part.type === "input_text" && part.text.trim() !== "");
}

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  const cryptoValue = globalThis.crypto;
  if (!cryptoValue?.getRandomValues) throw new Error("Secure random generation is unavailable.");
  cryptoValue.getRandomValues(data);
  return toBase64Url(data);
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  if (typeof btoa === "function") return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const buffer = Reflect.get(globalThis, "Buffer") as { from(input: Uint8Array): { toString(encoding: string): string } } | undefined;
  if (!buffer) throw new Error("Base64 encoding is unavailable.");
  return buffer.from(value).toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, param: string, code: string): never {
  throw new OpenAIProtocolError({ message, param, code });
}
