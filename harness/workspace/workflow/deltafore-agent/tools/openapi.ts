import { readOptionalString, readRequiredString } from "./values";

export const DEFAULT_DELTAFORE_API_BASE_URL = "http://hookcode.win:7222";
export const DEFAULT_OPENAPI_URL = `${DEFAULT_DELTAFORE_API_BASE_URL}/openapi.json`;
export const DEFAULT_OBJECT_CONFIG_PATH = "/api/object-config";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const SAFE_PREVIEW_LIMIT = 12;
const SAFE_AGENT_FACT_ROW_LIMIT = 80;
const SAFE_AGENT_FACT_ARRAY_LIMIT = 40;
const SAFE_AGENT_FACT_OPTION_LIMIT = 12;
const SAFE_AGENT_FACT_ARRAY_COUNT_LIMIT = 16;
const SAFE_OBJECT_DEPTH = 5;
const SAFE_STRING_LIMIT = 1200;
const SAFE_FACT_STRING_LIMIT = 260;

export interface DeltaforeApiConfig {
  baseUrl: string;
  openApiUrl: string;
  objectConfigUrl: string;
  objectConfigPrompt: string;
  tools: DeltaforeToolDefinition[];
}

export interface DeltaforeToolDefinition {
  toolName: string;
  method: string;
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters: DeltaforeToolParameter[];
}

export interface DeltaforeToolParameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  type?: string;
  format?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  description?: string;
}

export interface DeltaforeToolResultData {
  status: number;
  statusText: string;
  url: string;
  method: string;
  path: string;
  params: Record<string, unknown>;
  preview: unknown;
  previewTruncated: boolean;
  truncated: boolean;
  responseSummary: ResponseSummary;
  agentFacts: AgentFacts;
}

export interface ResponseSummary {
  kind: "array" | "object" | "value" | "empty";
  total?: number;
  count?: number;
  keys?: string[];
  sample?: unknown;
}

export interface AgentFacts {
  kind: "array" | "object" | "value" | "empty";
  complete: boolean;
  truncated: boolean;
  rowsKey?: string;
  rowCount?: number;
  rows?: unknown[];
  arrays?: AgentFactArray[];
  fields?: Record<string, unknown>;
  page?: AgentFactsPage;
  nextPageArgs?: Record<string, unknown>;
  notes: string[];
}

export interface AgentFactArray {
  path: string;
  count: number;
  complete: boolean;
  rows: unknown[];
}

export interface AgentFactsPage {
  limit?: number;
  offset?: number;
  total?: number;
  hasMore?: boolean;
}

interface OpenApiDocument {
  servers?: Array<{ url?: string }>;
  components?: {
    parameters?: Record<string, unknown>;
  };
  paths?: Record<string, Record<string, unknown>>;
}

interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: unknown[];
}

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: {
    type?: string;
    format?: string;
    default?: unknown;
    minimum?: number;
    maximum?: number;
    enum?: unknown[];
  };
  description?: string;
  $ref?: string;
}

interface DeltaforeObjectConfigResponse {
  data?: unknown;
}

export async function createDeltaforeApiConfig(options: {
  baseUrl?: string;
  openApiUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
} = {}): Promise<DeltaforeApiConfig> {
  const openApiUrl = normalizeUrl(options.openApiUrl ?? DEFAULT_OPENAPI_URL, DEFAULT_OPENAPI_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(openApiUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to load OpenAPI document: ${response.status} ${response.statusText}`);
  }

  const document = await response.json() as OpenApiDocument;
  const baseUrl = normalizeUrl(options.baseUrl ?? resolveBaseUrl(document, openApiUrl), DEFAULT_DELTAFORE_API_BASE_URL);
  const objectConfigUrl = createObjectConfigUrl(baseUrl);
  const objectConfig = await loadObjectConfig(objectConfigUrl, fetchImpl, options.signal);

  return {
    baseUrl,
    openApiUrl,
    objectConfigUrl,
    objectConfigPrompt: createObjectConfigPrompt(objectConfig),
    tools: extractToolDefinitions(document),
  };
}

export function createObjectConfigPrompt(value: unknown): string {
  const config = unwrapObjectConfig(value);

  return [
    "固定配置字典来自 /api/object-config，已在 context 初始化时加载。除非用户明确要求查看原始配置，否则不要再调用 get_api_object_config。",
    "",
    "枪械配件槽位 slotId -> 中文槽位名/配件类型：",
    formatGunSlotDictionary(config),
    "",
    "物品类型映射 type -> 中文名：",
    formatObjectMappings(config),
    "",
    "集市兑换分组 groupType -> 中文名/类型：",
    formatExchangeGroups(config),
    "",
    "地图映射 mapId -> 中文名：",
    formatMapDictionary(config),
    "",
    "钥匙操作类型 keyType -> 中文名：",
    formatKeyTypes(config),
  ].filter((part) => part.trim() !== "").join("\n");
}

export async function runOpenApiTool(
  config: DeltaforeApiConfig,
  toolName: string,
  args: Record<string, unknown>,
  options: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<DeltaforeToolResultData> {
  const definition = findToolDefinition(config, toolName);
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = createRequest(config.baseUrl, definition, args);
  const response = await fetchImpl(request.url, {
    method: definition.method,
    headers: {
      accept: "application/json",
    },
    signal: options.signal,
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${stringifyErrorBody(body)}`);
  }

  const preview = createResponsePreview(body);
  const agentFacts = createAgentFacts(body, request.params);

  return {
    status: response.status,
    statusText: response.statusText,
    url: request.url,
    method: definition.method,
    path: definition.path,
    params: request.params,
    preview,
    previewTruncated: isPreviewTruncated(preview),
    truncated: agentFacts.truncated,
    responseSummary: summarizeResponse(body),
    agentFacts,
  };
}

export function findToolDefinition(config: DeltaforeApiConfig, toolName: string): DeltaforeToolDefinition {
  const definition = config.tools.find((tool) => tool.toolName === toolName);

  if (definition === undefined) {
    throw new Error(`Unknown Delta Force API tool: ${toolName}`);
  }

  return definition;
}

export function createToolCatalog(config: DeltaforeApiConfig): string {
  const lines = config.tools.map((tool) => {
    const params = tool.parameters.map(formatParameterSignature).join(", ");
    const maintenance = tool.method !== "GET" ? " [维护/同步接口，只有用户明确要求时使用]" : "";
    return `- ${tool.toolName}(${params}): ${tool.method} ${tool.path}，${tool.summary}${maintenance}`;
  });

  return [
    `接口来源：${config.openApiUrl}`,
    `API Base URL：${config.baseUrl}`,
    `可用工具数量：${config.tools.length}`,
    ...lines,
  ].join("\n");
}

export function createCompactToolCatalog(config: DeltaforeApiConfig): string {
  const groups = new Map<string, DeltaforeToolDefinition[]>();

  for (const tool of config.tools) {
    const tag = tool.tags[0] ?? "未分类";
    groups.set(tag, [...(groups.get(tag) ?? []), tool]);
  }

  return [...groups.entries()]
    .map(([tag, tools]) => {
      const names = tools.map((tool) => `${tool.toolName}: ${tool.summary}`).join("；");
      return `${tag}: ${names}`;
    })
    .join("\n");
}

export function extractToolDefinitions(document: OpenApiDocument): DeltaforeToolDefinition[] {
  const tools: DeltaforeToolDefinition[] = [];

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !isRecord(operationValue)) {
        continue;
      }

      const operation = operationValue as OpenApiOperation;
      tools.push({
        toolName: createToolName(method, path),
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? `${method.toUpperCase()} ${path}`,
        description: operation.description,
        tags: Array.isArray(operation.tags) ? operation.tags.filter(isString) : [],
        parameters: readParameters(document, operation.parameters ?? []),
      });
    }
  }

  return tools.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));
}

function readParameters(document: OpenApiDocument, parameters: unknown[]): DeltaforeToolParameter[] {
  return parameters
    .map((parameter) => resolveParameter(document, parameter))
    .filter((parameter): parameter is OpenApiParameter => parameter !== undefined)
    .filter((parameter) => parameter.in === "path" || parameter.in === "query")
    .filter((parameter) => typeof parameter.name === "string" && parameter.name.trim() !== "")
    .map((parameter) => ({
      name: parameter.name as string,
      in: parameter.in as "path" | "query",
      required: parameter.required === true || parameter.in === "path",
      type: parameter.schema?.type,
      format: parameter.schema?.format,
      default: parameter.schema?.default,
      minimum: parameter.schema?.minimum,
      maximum: parameter.schema?.maximum,
      enum: Array.isArray(parameter.schema?.enum) ? parameter.schema.enum.filter(isString) : undefined,
      description: parameter.description,
    }));
}

function resolveParameter(document: OpenApiDocument, parameter: unknown): OpenApiParameter | undefined {
  if (!isRecord(parameter)) {
    return undefined;
  }

  if (typeof parameter.$ref === "string") {
    const name = parameter.$ref.split("/").pop();
    const referenced = name === undefined ? undefined : document.components?.parameters?.[name];
    return isRecord(referenced) ? referenced as OpenApiParameter : undefined;
  }

  return parameter as OpenApiParameter;
}

function createRequest(
  baseUrl: string,
  definition: DeltaforeToolDefinition,
  args: Record<string, unknown>,
): { url: string; params: Record<string, unknown> } {
  let path = definition.path;
  const params: Record<string, unknown> = {};
  const url = new URL(path, `${baseUrl.replace(/\/+$/u, "")}/`);

  for (const parameter of definition.parameters) {
    const value = readParameterValue(parameter, args);
    if (value === undefined) {
      continue;
    }

    params[parameter.name] = value;
    if (parameter.in === "path") {
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
    } else {
      url.searchParams.set(parameter.name, String(value));
    }
  }

  url.pathname = path;
  return {
    url: url.toString(),
    params,
  };
}

function readParameterValue(parameter: DeltaforeToolParameter, args: Record<string, unknown>): unknown {
  const raw = args[parameter.name];

  if (raw === undefined || raw === null || raw === "") {
    if (parameter.required) {
      return readRequiredString(raw, parameter.name);
    }

    return undefined;
  }

  if (parameter.type === "integer" || parameter.type === "number") {
    const value = readNumber(raw, parameter);
    const minimum = parameter.minimum ?? Number.NEGATIVE_INFINITY;
    const maximum = parameter.maximum ?? Number.POSITIVE_INFINITY;
    return Math.min(maximum, Math.max(minimum, value));
  }

  if (parameter.type === "boolean") {
    return readBoolean(raw, parameter);
  }

  return readOptionalString(raw) ?? String(raw);
}

function readNumber(value: unknown, parameter: DeltaforeToolParameter): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const fallback = typeof parameter.default === "number" ? parameter.default : undefined;
  const number = Number.isFinite(parsed) ? parsed : fallback;

  if (number === undefined) {
    throw new Error(`Tool argument "${parameter.name}" must be a valid number.`);
  }

  return parameter.type === "integer" ? Math.trunc(number) : number;
}

function readBoolean(value: unknown, parameter: DeltaforeToolParameter): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n"].includes(normalized)) {
      return false;
    }
  }

  if (typeof parameter.default === "boolean") {
    return parameter.default;
  }

  throw new Error(`Tool argument "${parameter.name}" must be a valid boolean.`);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text.trim() === "") {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summarizeResponse(value: unknown): ResponseSummary {
  if (Array.isArray(value)) {
    return {
      kind: "array",
      count: value.length,
      sample: createSummarySample(value[0]),
    };
  }

  if (isRecord(value)) {
    const keys = Object.keys(value).slice(0, 20);
    const rows = readRows(value);

    return {
      kind: "object",
      total: readTotal(value),
      count: rows?.length,
      keys,
      sample: createSummarySample(rows?.[0] ?? value),
    };
  }

  if (value === null || value === undefined || value === "") {
    return {
      kind: "empty",
    };
  }

  return {
    kind: "value",
    sample: value,
  };
}

function createAgentFacts(value: unknown, params: Record<string, unknown>): AgentFacts {
  if (Array.isArray(value)) {
    const rows = value.slice(0, SAFE_AGENT_FACT_ROW_LIMIT).map((item) => createAgentFactValue(item, 3));

    return {
      kind: "array",
      complete: value.length <= SAFE_AGENT_FACT_ROW_LIMIT,
      truncated: value.length > SAFE_AGENT_FACT_ROW_LIMIT,
      rowCount: value.length,
      rows,
      notes: [
        value.length > SAFE_AGENT_FACT_ROW_LIMIT
          ? `agentFacts.rows only includes the first ${SAFE_AGENT_FACT_ROW_LIMIT} rows from a ${value.length}-row array.`
          : "agentFacts.rows contains the full array response.",
      ],
    };
  }

  if (!isRecord(value)) {
    return {
      kind: value === null || value === undefined || value === "" ? "empty" : "value",
      complete: true,
      truncated: false,
      fields: value === null || value === undefined || value === "" ? undefined : { value: createAgentFactValue(value, 2) },
      notes: [],
    };
  }

  const attachmentOptionsFacts = createAttachmentOptionsAgentFacts(value);
  if (attachmentOptionsFacts !== undefined) {
    return attachmentOptionsFacts;
  }

  const rows = readRowsWithKey(value);
  const page = readPage(value);
  const arrays = collectAgentFactArrays(value, rows?.key);
  const fields = createAgentFactFields(value, rows?.key);
  const notes: string[] = [];
  const rowTruncated = rows !== undefined && rows.length > SAFE_AGENT_FACT_ROW_LIMIT;
  const nestedTruncated = arrays.some((array) => !array.complete);
  const pageHasMore = page?.hasMore === true;

  if (rows !== undefined) {
    notes.push(
      rowTruncated
        ? `agentFacts.rows includes the first ${SAFE_AGENT_FACT_ROW_LIMIT} rows from ${rows.length} returned rows.`
        : "agentFacts.rows contains every row returned by this HTTP response.",
    );
  }

  if (pageHasMore) {
    notes.push("The HTTP API reports page.hasMore=true; call the same tool with nextPageArgs to fetch the next API page.");
  } else if (rows !== undefined) {
    notes.push("Do not treat uiPreview truncation as missing data; use agentFacts.rows for complete returned rows.");
  }

  return {
    kind: "object",
    complete: !rowTruncated && !nestedTruncated && !pageHasMore,
    truncated: rowTruncated || nestedTruncated,
    rowsKey: rows?.key,
    rowCount: rows?.length,
    rows: rows?.value.slice(0, SAFE_AGENT_FACT_ROW_LIMIT).map((item) => createAgentFactValue(item, 3)),
    arrays: arrays.length === 0 ? undefined : arrays,
    fields,
    page,
    nextPageArgs: pageHasMore ? createNextPageArgs(params, page) : undefined,
    notes,
  };
}

function createAttachmentOptionsAgentFacts(value: Record<string, unknown>): AgentFacts | undefined {
  const data = isRecord(value.data) ? value.data : undefined;
  const slots = Array.isArray(data?.slots) ? data.slots.filter(isRecord) : undefined;

  if (data === undefined || slots === undefined) {
    return undefined;
  }

  return {
    kind: "object",
    complete: true,
    truncated: false,
    rowsKey: "data.slots",
    rowCount: slots.length,
    rows: slots.map(createAttachmentSlotFact),
    fields: {
      gun: createAgentFactFieldValue(data.gun, 2),
      matchSource: createAgentFactFieldValue(data.matchSource, 1),
    },
    notes: [
      "agentFacts.rows contains compact slot summaries from the attachment-options response.",
      "Each slot keeps a small set of representative candidates chosen by control speed, recoil control, stability, hip-fire, and price so the ReAct loop avoids oversized tool context.",
    ],
  };
}

function createAttachmentSlotFact(value: Record<string, unknown>): Record<string, unknown> {
  const options = Array.isArray(value.options) ? value.options.filter(isRecord) : [];

  return {
    slotId: value.slotId,
    slotName: value.slotName,
    accType: value.accType,
    slotScope: value.slotScope,
    slotSortOrder: value.slotSortOrder,
    optionCount: value.optionCount ?? options.length,
    options: selectRepresentativeAttachmentOptions(options).map(createAttachmentOptionFact),
    optionsSummarized: true,
    originalOptionCount: options.length,
  };
}

function selectRepresentativeAttachmentOptions(options: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const selected: Record<string, unknown>[] = [];
  const addTop = (score: (option: Record<string, unknown>) => number | undefined, limit: number, positiveOnly = false) => {
    const ranked = options
      .map((option) => ({ option, score: score(option) }))
      .filter((item): item is { option: Record<string, unknown>; score: number } =>
        item.score !== undefined && Number.isFinite(item.score) && (!positiveOnly || item.score > 0),
      )
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    for (const item of ranked) {
      if (!selected.some((existing) => readAttachmentOptionId(existing) === readAttachmentOptionId(item.option))) {
        selected.push(item.option);
      }
    }
  };

  addTop((option) => readAttachmentStat(option, "control_speed"), 3);
  addTop((option) => readAttachmentStat(option, "recoil"), 2, true);
  addTop((option) => readAttachmentStat(option, "control_stable"), 2, true);
  addTop((option) => readAttachmentStat(option, "hip_shot"), 1, true);
  addTop((option) => {
    const price = readItemNumber(option, "avgPrice");
    return price === undefined ? undefined : -price;
  }, 1);

  if (selected.length === 0) {
    return options.slice(0, Math.min(SAFE_AGENT_FACT_OPTION_LIMIT, 4));
  }

  return selected.slice(0, SAFE_AGENT_FACT_OPTION_LIMIT);
}

function collectAgentFactArrays(value: Record<string, unknown>, rowsKey: string | undefined): AgentFactArray[] {
  const arrays: AgentFactArray[] = [];

  collectAgentFactArraysAtPath(value, "", arrays, rowsKey);

  return arrays.slice(0, SAFE_AGENT_FACT_ARRAY_COUNT_LIMIT);
}

function collectAgentFactArraysAtPath(
  value: unknown,
  path: string,
  arrays: AgentFactArray[],
  skipRootArrayKey?: string,
): void {
  if (arrays.length >= SAFE_AGENT_FACT_ARRAY_COUNT_LIMIT) {
    return;
  }

  if (Array.isArray(value)) {
    arrays.push({
      path,
      count: value.length,
      complete: value.length <= SAFE_AGENT_FACT_ARRAY_LIMIT,
      rows: value.slice(0, SAFE_AGENT_FACT_ARRAY_LIMIT).map((item) => createAgentFactArrayRow(item, path)),
    });
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (path === "" && key === skipRootArrayKey) {
      continue;
    }

    collectAgentFactArraysAtPath(item, path ? `${path}.${key}` : key, arrays);
  }
}

function createAgentFactArrayRow(value: unknown, path: string): unknown {
  if (path.endsWith(".slots") && isRecord(value)) {
    const slot = createKnownFactRecord(value) ?? {};
    const options = Array.isArray(value.options) ? value.options.filter(isRecord) : [];

    return {
      ...slot,
      options: options.slice(0, SAFE_AGENT_FACT_OPTION_LIMIT).map(createAttachmentOptionFact),
      optionsTruncated: options.length > SAFE_AGENT_FACT_OPTION_LIMIT,
    };
  }

  if (path.endsWith(".options") && isRecord(value)) {
    return createAttachmentOptionFact(value);
  }

  return createAgentFactValue(value, 2);
}

function createAttachmentOptionFact(value: Record<string, unknown>): Record<string, unknown> {
  const item = isRecord(value.item) ? value.item : {};
  const attachment = isRecord(value.attachment) ? value.attachment : {};
  const effects = Array.isArray(value.effects) ? value.effects.filter(isRecord) : [];

  return {
    matchSource: readStringValue(value.matchSource),
    objectId: item.objectId ?? item.objectID ?? item.object_id,
    objectName: readStringValue(item.objectName ?? item.gameName),
    primaryClass: readStringValue(item.primaryClass),
    secondClass: readStringValue(item.secondClass),
    secondClassCn: readStringValue(item.secondClassCn ?? item.secondClassCN),
    grade: item.grade,
    avgPrice: item.avgPrice,
    attachment: createKnownFactRecord(attachment) ?? createAgentFactFieldValue(attachment, 1),
    effects: effects.slice(0, 6).map((effect) => ({
      effectType: readStringValue(effect.effectType),
      valueText: readStringValue(effect.valueText),
      conditionText: readStringValue(effect.conditionText),
      batteryValue: effect.batteryValue,
    })),
  };
}

function readAttachmentOptionId(value: Record<string, unknown>): unknown {
  const item = isRecord(value.item) ? value.item : value;
  return item.objectId ?? item.objectID ?? item.object_id ?? item.objectName ?? item.gameName;
}

function readAttachmentStat(value: Record<string, unknown>, key: string): number | undefined {
  const attachment = isRecord(value.attachment) ? value.attachment : value;
  return readFiniteNumber(attachment[key]);
}

function readItemNumber(value: Record<string, unknown>, key: string): number | undefined {
  const item = isRecord(value.item) ? value.item : value;
  return readFiniteNumber(item[key]);
}

function createAgentFactFields(value: Record<string, unknown>, rowsKey: string | undefined): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    if (key === rowsKey || Array.isArray(item)) {
      continue;
    }

    output[key] = createAgentFactFieldValue(item, 3);
  }

  return output;
}

function createAgentFactFieldValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > SAFE_FACT_STRING_LIMIT ? `${value.slice(0, SAFE_FACT_STRING_LIMIT)}...` : value;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return `[Array ${value.length}]`;
  }

  if (depth <= 0) {
    return "[Object]";
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isLowValueFactField(key)) {
      continue;
    }

    output[key] = createAgentFactFieldValue(item, depth - 1);
  }

  return output;
}

function createAgentFactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > SAFE_FACT_STRING_LIMIT ? `${value.slice(0, SAFE_FACT_STRING_LIMIT)}...` : value;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, SAFE_AGENT_FACT_ARRAY_LIMIT).map((item) => createAgentFactValue(item, depth - 1));
  }

  if (depth <= 0) {
    return createKnownFactRecord(value) ?? "[Object]";
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isLowValueFactField(key)) {
      continue;
    }

    output[key] = createAgentFactValue(item, depth - 1);
  }

  return output;
}

function createKnownFactRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};

  for (const key of [
    "objectId",
    "objectID",
    "object_id",
    "objectName",
    "gameName",
    "primaryClass",
    "secondClass",
    "secondClassCn",
    "secondClassCN",
    "grade",
    "avgPrice",
    "slotId",
    "slotName",
    "accType",
    "slotScope",
    "slotSortOrder",
    "optionCount",
    "matchSource",
    "control_speed",
    "control_stable",
    "quick_separate",
    "bomb_capacity",
    "hip_shot",
    "recoil",
    "shot_distance_percent",
    "effectType",
    "valueText",
    "batteryValue",
    "batteryColor",
    "conditionText",
  ]) {
    if (value[key] !== undefined && !isLowValueFactField(key)) {
      output[key] = createAgentFactFieldValue(value[key], 1);
    }
  }

  if (isRecord(value.item)) {
    output.item = createKnownFactRecord(value.item) ?? createAgentFactFieldValue(value.item, 1);
  }

  if (isRecord(value.attachment)) {
    output.attachment = createKnownFactRecord(value.attachment) ?? createAgentFactFieldValue(value.attachment, 1);
  }

  if (Array.isArray(value.effects)) {
    output.effects = value.effects
      .filter(isRecord)
      .slice(0, 8)
      .map((effect) => createKnownFactRecord(effect) ?? createAgentFactFieldValue(effect, 1));
  }

  return Object.keys(output).length === 0 ? undefined : output;
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isLowValueFactField(key: string): boolean {
  return key === "picUrl" ||
    key === "previewPicUrl" ||
    key === "iconUrl" ||
    key === "sourceUrl" ||
    key === "cdnUrl" ||
    key.endsWith("Url");
}

function readPage(value: Record<string, unknown>): AgentFactsPage | undefined {
  const raw = value.page;

  if (!isRecord(raw)) {
    return undefined;
  }

  return {
    limit: readFiniteNumber(raw.limit),
    offset: readFiniteNumber(raw.offset),
    total: readFiniteNumber(raw.total),
    hasMore: typeof raw.hasMore === "boolean" ? raw.hasMore : undefined,
  };
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createNextPageArgs(params: Record<string, unknown>, page: AgentFactsPage): Record<string, unknown> | undefined {
  if (page.limit === undefined || page.offset === undefined) {
    return undefined;
  }

  return {
    ...params,
    limit: page.limit,
    offset: page.offset + page.limit,
  };
}

function isPreviewTruncated(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length >= SAFE_PREVIEW_LIMIT;
  }

  return isRecord(value) && value.truncated === true;
}

function createSummarySample(value: unknown): unknown {
  if (!isRecord(value)) {
    return limitPreviewValue(value, 1);
  }

  const output: Record<string, unknown> = {};
  for (const key of [
    "objectId",
    "objectID",
    "id",
    "baseObjectId",
    "objectName",
    "gameName",
    "name",
    "title",
    "primaryClass",
    "secondClass",
    "secondClassCn",
    "thirdClass",
    "thirdClassCn",
    "grade",
    "avgPrice",
    "slotId",
    "slotScope",
  ]) {
    if (value[key] !== undefined) {
      output[key] = limitPreviewValue(value[key], 1);
    }
  }

  return Object.keys(output).length === 0 ? limitPreviewValue(value, 1) : output;
}

function createResponsePreview(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, SAFE_PREVIEW_LIMIT).map((item) => limitPreviewValue(item, SAFE_OBJECT_DEPTH));
  }

  if (!isRecord(value)) {
    return limitPreviewValue(value, SAFE_OBJECT_DEPTH);
  }

  const rows = readRowsWithKey(value);
  if (rows !== undefined) {
    return {
      ...limitPreviewObjectWithoutRows(value, rows.key),
      [rows.key]: rows.value.slice(0, SAFE_PREVIEW_LIMIT).map((item) => limitPreviewValue(item, SAFE_OBJECT_DEPTH)),
      truncated: rows.length > SAFE_PREVIEW_LIMIT,
    };
  }

  return limitPreviewValue(value, SAFE_OBJECT_DEPTH);
}

function readRows(value: Record<string, unknown>): unknown[] | undefined {
  return readRowsWithKey(value)?.value;
}

function readRowsWithKey(value: Record<string, unknown>): { key: string; value: unknown[]; length: number } | undefined {
  for (const key of ["data", "rows", "items", "results", "list"]) {
    const rows = value[key];
    if (Array.isArray(rows)) {
      return {
        key,
        value: rows,
        length: rows.length,
      };
    }
  }

  return undefined;
}

function limitPreviewObjectWithoutRows(value: Record<string, unknown>, rowsKey: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    if (key === rowsKey) {
      continue;
    }

    output[key] = limitPreviewValue(item, 2);
  }

  return output;
}

function limitPreviewValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return value.length > SAFE_STRING_LIMIT ? `${value.slice(0, SAFE_STRING_LIMIT)}...` : value;
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, SAFE_PREVIEW_LIMIT).map((item) => limitPreviewValue(item, depth - 1));
  }

  if (depth <= 0) {
    return "[Object]";
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = limitPreviewValue(item, depth - 1);
  }

  return output;
}

function readTotal(value: Record<string, unknown>): number | undefined {
  for (const key of ["total", "count"]) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
  }

  const page = value.page;
  if (isRecord(page) && typeof page.total === "number") {
    return page.total;
  }

  return undefined;
}

function resolveBaseUrl(document: OpenApiDocument, openApiUrl: string): string {
  const remote = document.servers
    ?.map((server) => server.url)
    .filter(isString)
    .find((url) => url.includes("hookcode.win"));

  return remote ?? new URL(openApiUrl).origin;
}

function createObjectConfigUrl(baseUrl: string): string {
  const url = new URL(DEFAULT_OBJECT_CONFIG_PATH, `${baseUrl.replace(/\/+$/u, "")}/`);
  return url.toString();
}

async function loadObjectConfig(
  objectConfigUrl: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(objectConfigUrl, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to load object config: ${response.status} ${response.statusText}`);
  }

  const body = await response.json() as DeltaforeObjectConfigResponse;
  return body;
}

function unwrapObjectConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  return isRecord(value.data) ? value.data : value;
}

function formatGunSlotDictionary(config: Record<string, unknown>): string {
  const slots = readRecordArray(config.gunSlots)
    .map((slot) => ({
      slotId: readNonEmptyString(slot.slotId),
      slotName: readNonEmptyString(slot.slotName),
      accType: readNonEmptyString(slot.accType),
      sortOrder: readFiniteNumber(slot.sortOrder),
    }))
    .filter((slot) => slot.slotId !== undefined && slot.slotName !== undefined)
    .sort(compareBySortOrderThenName);

  if (slots.length === 0) {
    return "- 暂无。";
  }

  return slots
    .map((slot) => {
      const accType = slot.accType === undefined ? "" : `/${slot.accType}`;
      return `- ${slot.slotId}=${slot.slotName}${accType}`;
    })
    .join("\n");
}

function formatObjectMappings(config: Record<string, unknown>): string {
  if (!isRecord(config.objectMappings)) {
    return "- 暂无。";
  }

  return Object.entries(config.objectMappings)
    .map(([group, mappings]) => {
      const pairs = readRecordArray(mappings)
        .map((mapping) => ({
          type: readNonEmptyString(mapping.type),
          typeName: readNonEmptyString(mapping.typeName),
          sourceOrder: readFiniteNumber(mapping.sourceOrder),
        }))
        .filter((mapping) => mapping.type !== undefined && mapping.typeName !== undefined)
        .sort(compareBySortOrderThenName)
        .map((mapping) => `${mapping.type}=${mapping.typeName}`);
      return pairs.length === 0 ? undefined : `- ${group}: ${pairs.join("；")}`;
    })
    .filter(isString)
    .join("\n") || "- 暂无。";
}

function formatExchangeGroups(config: Record<string, unknown>): string {
  const groups = readRecordArray(config.exchange)
    .map((group) => ({
      groupType: readNonEmptyString(group.groupType),
      groupName: readNonEmptyString(group.groupName),
      sourceOrder: readFiniteNumber(group.sourceOrder),
      items: readRecordArray(group.items)
        .map((item) => ({
          type: readNonEmptyString(item.type),
          typeName: readNonEmptyString(item.typeName),
          sourceOrder: readFiniteNumber(item.sourceOrder),
        }))
        .filter((item) => item.type !== undefined && item.typeName !== undefined)
        .sort(compareBySortOrderThenName),
    }))
    .filter((group) => group.groupType !== undefined && group.groupName !== undefined)
    .sort(compareBySortOrderThenName);

  if (groups.length === 0) {
    return "- 暂无。";
  }

  return groups
    .map((group) => {
      const items = group.items.map((item) => `${item.type}=${item.typeName}`).join("；");
      return `- ${group.groupType}=${group.groupName}${items === "" ? "" : `：${items}`}`;
    })
    .join("\n");
}

function formatMapDictionary(config: Record<string, unknown>): string {
  if (!isRecord(config.maps)) {
    return "- 暂无。";
  }

  return Object.entries(config.maps)
    .map(([mapType, maps]) => {
      const pairs = readRecordArray(maps)
        .map((map) => ({
          mapId: readNonEmptyString(map.mapId),
          mapName: readNonEmptyString(map.mapName),
          sourceOrder: readFiniteNumber(map.sourceOrder),
        }))
        .filter((map) => map.mapId !== undefined && map.mapName !== undefined)
        .sort(compareBySortOrderThenName)
        .map((map) => `${map.mapId}=${map.mapName}`);
      return pairs.length === 0 ? undefined : `- ${mapType}: ${pairs.join("；")}`;
    })
    .filter(isString)
    .join("\n") || "- 暂无。";
}

function formatKeyTypes(config: Record<string, unknown>): string {
  const pairs = readRecordArray(config.keyTypes)
    .map((keyType) => ({
      keyType: readNonEmptyString(keyType.keyType),
      name: readNonEmptyString(keyType.name),
      sourceOrder: readFiniteNumber(keyType.sourceOrder),
    }))
    .filter((keyType) => keyType.keyType !== undefined && keyType.name !== undefined)
    .sort(compareBySortOrderThenName)
    .map((keyType) => `${keyType.keyType}=${keyType.name}`);

  return pairs.length === 0 ? "- 暂无。" : `- ${pairs.join("；")}`;
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function compareBySortOrderThenName(
  left: { sortOrder?: number; sourceOrder?: number; slotId?: string; type?: string; groupType?: string; mapId?: string; keyType?: string },
  right: { sortOrder?: number; sourceOrder?: number; slotId?: string; type?: string; groupType?: string; mapId?: string; keyType?: string },
): number {
  const leftOrder = left.sortOrder ?? left.sourceOrder ?? Number.POSITIVE_INFINITY;
  const rightOrder = right.sortOrder ?? right.sourceOrder ?? Number.POSITIVE_INFINITY;

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  const leftName = left.slotId ?? left.type ?? left.groupType ?? left.mapId ?? left.keyType ?? "";
  const rightName = right.slotId ?? right.type ?? right.groupType ?? right.mapId ?? right.keyType ?? "";
  return leftName.localeCompare(rightName, "zh-Hans-CN", { numeric: true });
}

function normalizeUrl(value: string, fallback: string): string {
  try {
    return new URL(value).toString().replace(/\/$/u, "");
  } catch {
    return fallback;
  }
}

function createToolName(method: string, path: string): string {
  return `${method.toLowerCase()}_${path
    .replace(/^\//u, "")
    .replace(/[{}]/gu, "")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/_$/u, "")}`;
}

function formatParameterSignature(parameter: DeltaforeToolParameter): string {
  const required = parameter.required ? "" : "?";
  const type = parameter.enum?.length ? parameter.enum.join("|") : parameter.type ?? "string";
  return `${parameter.name}${required}: ${type}`;
}

function stringifyErrorBody(value: unknown): string {
  if (typeof value === "string") {
    return value.slice(0, 500);
  }

  return JSON.stringify(value)?.slice(0, 500) ?? "";
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
