import { t } from './localization';
export type ProjectKind = 'conversation' | 'workflow' | 'kanban';

export interface Field {
  name: string;
  flag?: string;
  type: string;
  control?: string;
  panel?: string;
  label?: string;
  description?: string;
  command?: string;
  required?: boolean;
  defaultValue?: string;
  multiple?: boolean;
  resolveOnInput?: boolean;
  options?: { value: string; label?: string; description?: string; command?: string }[];
  accept?: string[];
  format?: 'json';
  step?: number;
  audio?: { maxDurationSeconds?: number; maxBytes?: number };
}

export interface ParamLayout {
  actions: (
    | { kind: 'quick' | 'auxiliary'; id: string; label: string; summary?: string[]; params: string[] }
    | { kind: 'mode'; name: string }
    | { kind: 'slash'; name: string }
  )[];
}

export type ParamValue = string | string[];
export type ParamValues = Record<string, ParamValue>;
export interface ParamState {
  value?: ParamValue | null;
  visible?: boolean;
  disabled?: boolean;
  resolvedOptions?: Field['options'] | null;
  options?: Record<string, { visible?: boolean; disabled?: boolean }>;
}

export interface Parameters {
  fields: Field[];
  paramLayout?: ParamLayout;
  paramResolver?: { enabled: true };
  tools?: Tool[];
}

export interface ParamRequest {
  draftText: string;
  args: string[];
  inputMode: 'form' | 'raw';
  trigger: { kind: 'init' | 'input' } | { kind: 'param'; paramName: string };
}

export interface Project extends Parameters {
  projectCard?: import('@steamharness/project-card-metadata').ProjectCardMetadata;
  aggregateProjectCard?: import('@steamharness/project-card-metadata').ProjectCardMetadata;
  entryId: string;
  aggregateName: string;
  entries: import('@steamharness/project-manifest').ProjectEntry[];
  defaultEntry: string;
  entryRoot: string;
  databases: import('@steamharness/database-spaces').DatabaseRequirement[];
  id: string;
  uri: string;
  folderPath: string;
  name: string;
  projectType: ProjectKind;
  manifest?: { name?: string; version?: string; description?: string };
  entrypoints: (Parameters & { id: string; title?: string })[];
  defaultEntrypoint?: string;
  artifactEntry?: string;
  requiresLogin?: boolean;
  builtin?: 'analysis';
  assistant?: { workdir: string; roots: AssistantWorkspaceFolder[]; standalone?: boolean };
  conversation?: {
    footer?: ConversationFooterItem[];
    attachments?: { images?: boolean; videos?: boolean; files?: boolean };
    inputQueue?: { enabled?: boolean };
  };
}

export interface ConversationFooterItem {
  text?: string;
  localizedText?: Record<string, string>;
  param?: string;
  when?: { param: string; value: string };
}

export interface AssistantWorkspaceFolder { uri: string; folderPath: string; name: string }

export interface Tool { name: string; label?: string; description?: string; enabled?: boolean; autoApprove?: boolean }
export type ToolPolicies = Record<string, { enabled?: boolean; autoApprove?: boolean }>;
export interface Attachment {
  id: string; name: string; mimeType: string; size: number; kind: 'image' | 'file';
  storage: 'local' | 'server'; projectId?: string; conversationId?: string; createdAt: string;
  path?: string; url?: string; previewUrl?: string;
}
export interface Upload { name: string; mimeType?: string; data?: string; path?: string }
export interface InputRequest {
  requestId: string; nodeName: string; title: string; description?: string; params: Field[];
  defaultValues?: Record<string, unknown>; createdAt?: string;
  metadata?: { type?: string; toolName?: string; toolArguments?: unknown; [key: string]: unknown };
}
export interface ResolvedInput { requestId: string; nodeName: string; values: Record<string, unknown>; submittedAt: string; request?: InputRequest; precedingOutputItemIds?: string[] }

export interface OutputItem {
  id?: string;
  title?: string;
  content: unknown;
  contentType?: string;
  display?: { type: 'ring'; placement?: 'inline' | 'composer-right' };
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TimerRecord {
  timerId: string; title: string; startedAt: string; endedAt?: string; durationMs?: number;
  status: 'running' | 'success' | 'failed' | 'cleared'; message?: string;
}

export interface Report {
  status: string;
  durationMs?: number;
  output?: { items?: OutputItem[] };
  error?: { message?: string; metadata?: Record<string, unknown> };
  result?: { success?: boolean; data?: unknown; error?: { message?: string } };
  runId?: string;
  pendingUserInput?: InputRequest;
  resolvedUserInputs?: ResolvedInput[];
  tokenUsage?: { enabled: true; display: boolean; run: Record<string, unknown> };
  nodes?: Record<string, unknown>[];
  logs?: string;
  files?: Attachment[];
  timers?: TimerRecord[];
  [key: string]: unknown;
}

export interface Run {
  project: Project;
  conversationId: string;
  args: string[];
  entrypointId?: string;
  runId?: string;
  resolvedInputs?: ResolvedInput[];
  resumeAfterRequestId?: string;
  toolPermissionPolicies?: ToolPolicies;
}

export interface Runtime {
  available: boolean;
  inspect(paths: string[]): Promise<{ projects: Omit<Project, 'uri'>[]; errors: string[] }>;
  resolveParams(project: Project, request: ParamRequest, entrypointId?: string): Promise<{ params?: Record<string, ParamState> }>;
  run(request: Run, onEvent: (event: Record<string, unknown>) => void): Promise<Report>;
  uploadFiles(project: Project, conversationId: string, files: Upload[]): Promise<Attachment[]>;
  readFile(project: Project, id: string): Promise<{ reference: Attachment; path: string }>;
  deleteFiles(project: Project, conversationId: string, ids: string[]): Promise<void>;
  readResource(project: Project, conversationId: string, kind: 'kv' | 'knowledge', target: Record<string, string>): Promise<unknown>;
  deleteConversation(project: Project, conversationId: string): Promise<void>;
  cancel(runId?: string): void;
  dispose(): void;
}

export interface ConversationMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  items?: OutputItem[];
  error?: string;
  status?: string;
  durationMs?: number;
  createdAt?: number;
  model?: string;
  attachments?: Attachment[];
  args?: string[];
  entrypointId?: string;
  runId?: string;
  pendingInput?: InputRequest;
  resolvedInputs?: ResolvedInput[];
  submittingInput?: ResolvedInput;
  tokenUsage?: Report['tokenUsage'];
  report?: Report;
  events?: Record<string, unknown>[];
  input?: Omit<ConversationQueuedInput, 'id' | 'createdAt'>;
  files?: Attachment[];
  timers?: TimerRecord[];
}

export interface ConversationQueuedInput { id: string; text: string; params: ParamValues; states?: Record<string, ParamState>; entrypointId?: string; attachments: Attachment[]; createdAt: number }

export interface ConversationSession {
  id: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  messages: ConversationMessage[];
  parameterValues?: Record<string, ParamValues>;
  toolPermissionPolicies?: ToolPolicies;
  queuedInputs?: ConversationQueuedInput[];
  draft?: { text: string; attachments: Attachment[]; editingQueueId?: string };
  titleLocked?: boolean;
  activeRunId?: string;
}

export const projectTypeLabels: Record<ProjectKind, string> = {
  get conversation() { return t("Conversation"); },
  get workflow() { return t("Workflow"); },
  get kanban() { return t("Kanban"); },
};

export function projectVersion(project: Project): string | undefined { return project.manifest?.version; }
export function projectDisplayName(project: Project): string {
  return `${project.aggregateName} / ${project.name}`;
}

export function projectParameters(project: Project, entrypointId?: string): Parameters {
  return project.entrypoints.find((entry) => entry.id === entrypointId) ?? project;
}

export function projectParamValue(field: Field, value: ParamValue = field.defaultValue ?? ''): ParamValue {
  if (field.type === 'file' || field.control === 'audio' || !(field.multiple || field.control === 'checkboxes') || Array.isArray(value)) { return value; }
  if (!value.trim()) { return []; }
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) { return parsed.filter((entry) => ['string', 'number', 'boolean'].includes(typeof entry)).map(String); }
  } catch { /* A single selection can also be an ordinary string. */ }
  return [value];
}

export function projectFormValue(field: Field, value: unknown): ParamValue {
  if (value === undefined || value === null) { return projectParamValue(field); }
  if (typeof value === 'string') { return projectParamValue(field, value); }
  if (field.type === 'file' || field.control === 'audio' || field.format === 'json') { return JSON.stringify(value); }
  return projectParamValue(field, Array.isArray(value) ? value.map(String) : String(value));
}

export function projectParamArgs(fields: Field[], values: ParamValues, states: Record<string, ParamState> = {}): string[] {
  const args: string[] = [];
  for (const field of fields) {
    if (states[field.name]?.visible === false) { continue; }
    const value = projectParamValue(field, values[field.name]);
    const entries = Array.isArray(value) ? value.length ? [JSON.stringify(value)] : [] : [value];
    for (const entry of entries) {
      if (entry === '') { continue; }
      if (field.flag) { args.push(field.flag, entry); }
      else if (field.type === 'positional') { args.push(entry); }
    }
  }
  return args;
}

export function applyOutputChunk(items: OutputItem[], value: unknown): void {
  if (!value || typeof value !== 'object') { return; }
  const chunk = value as { type?: string; item?: OutputItem; itemId?: string; delta?: unknown };
  if (chunk.type === 'output_item_start' && chunk.item) {
    const index = items.findIndex((item) => item.id && item.id === chunk.item?.id);
    if (index >= 0) { items[index] = { ...chunk.item }; }
    else { items.push({ ...chunk.item }); }
  } else if (chunk.type === 'output_item_delta') {
    const item = items.find((entry) => entry.id === chunk.itemId);
    if (item) {
      if (chunk.item) { Object.assign(item, { ...chunk.item, metadata: { ...item.metadata, ...chunk.item.metadata } }); }
      if (typeof chunk.delta === 'string') { item.content = `${typeof item.content === 'string' ? item.content : ''}${chunk.delta}`; }
      else if (chunk.delta !== undefined) { item.content = chunk.delta; }
    }
  }
}

export function outputText(items: OutputItem[]): string {
  return items.filter((item) => !item.collapsed && item.metadata?.plan !== true && ['text', 'markdown', undefined].includes(item.contentType))
    .map((item) => typeof item.content === 'string' ? item.content : '').filter(Boolean).join('\n\n');
}

export function validateProjectValues(fields: Field[], values: ParamValues, states: Record<string, ParamState> = {}): void {
  for (const field of fields) {
    if (states[field.name]?.visible === false || states[field.name]?.disabled) { continue; }
    const value = projectParamValue(field, values[field.name]);
    const label = field.label || field.name;
    if (field.required && (typeof value === 'string' && !value.trim() || Array.isArray(value) && !value.length)) { throw new Error(t("Please enter {0}.", label)); }
    if (value === '' || Array.isArray(value) && !value.length) { continue; }
    if (field.type === 'number' && (typeof value !== 'string' || !Number.isFinite(Number(value)))) { throw new Error(t("{0} must be a valid number.", label)); }
    if (field.type === 'boolean' && value !== 'true' && value !== 'false') { throw new Error(t("{0} must be a valid boolean.", label)); }
    if (field.format === 'json' || field.type === 'file' || field.control === 'audio') {
      let parsed: unknown;
      try { parsed = JSON.parse(typeof value === 'string' ? value : JSON.stringify(value)); }
      catch { throw new Error(t("{0} must be valid JSON.", label)); }
      if (field.required && (field.type === 'file' || field.control === 'audio') && (parsed === null || Array.isArray(parsed) && !parsed.length)) { throw new Error(t("Please enter {0}.", label)); }
    }
    const choices = states[field.name]?.resolvedOptions ?? field.options;
    if (choices && choices.length > 0) {
      const allowed = new Set(choices.filter((option) => states[field.name]?.options?.[option.value]?.visible !== false && !states[field.name]?.options?.[option.value]?.disabled).map((option) => option.value));
      if ((Array.isArray(value) ? value : [value]).some((entry) => !allowed.has(entry))) { throw new Error(t("The options for {0} have changed. Please select again.", label)); }
    }
  }
}

export function resolvedProjectValues(fields: Field[], values: ParamValues): Record<string, unknown> {
  validateProjectValues(fields, values);
  return Object.fromEntries(fields.map((field) => {
    const value = projectParamValue(field, values[field.name]);
    if (field.type === 'boolean') { return [field.name, value === 'true']; }
    if (field.type === 'number' && value !== '') { return [field.name, Number(value)]; }
    if ((field.type === 'file' || field.control === 'audio' || field.format === 'json') && typeof value === 'string' && value !== '') { return [field.name, JSON.parse(value)]; }
    return [field.name, value];
  }));
}

export function redactProjectData(value: unknown, secrets: string[] = [], redactKeys = true): unknown {
  if (typeof value === 'string') { for (const secret of secrets.filter(Boolean)) { value = (value as string).replaceAll(secret, '[redacted]'); } return value; }
  if (Array.isArray(value)) { return value.map((entry) => redactProjectData(entry, secrets, redactKeys)); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      redactKeys && /password|secret|authorization|cookie|^(?:api[-_]?key|access[-_]?token|refresh[-_]?token)$/i.test(key) ? '[redacted]' : redactProjectData(entry, secrets, redactKeys)]));
  }
  return value;
}

/** A window identity is independent from its real filesystem URI. */
export function projectWindowKey(project: Pick<Project, 'uri' | 'entryId'>): string { return `${project.uri}#entry=${project.entryId}`; }
