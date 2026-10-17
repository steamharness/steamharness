import { t } from './localization';
import type { KanbanArtifactConfig, KanbanBridgeCall } from '@workflow-code/kanban-project';
import type { WorkflowProjectInfo } from '@workflow-code/project-info';
import type { AgentSessionCommand, AgentSessionReceipt, AgentSessionSnapshot } from 'workflow-code/agent';

export type WorkflowProjectType = 'conversation' | 'workflow' | 'kanban';

export interface WorkflowField {
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

export interface WorkflowParamLayout {
  actions: (
    | { kind: 'quick' | 'auxiliary'; id: string; label: string; icon?: string; summary?: string[]; params: string[] }
    | { kind: 'mode'; name: string }
    | { kind: 'slash'; name: string }
  )[];
}

export type WorkflowParamValue = string | string[];
export type WorkflowParamValues = Record<string, WorkflowParamValue>;
export interface WorkflowParamState {
  value?: WorkflowParamValue | null;
  visible?: boolean;
  disabled?: boolean;
  resolvedOptions?: WorkflowField['options'] | null;
  options?: Record<string, { visible?: boolean; disabled?: boolean }>;
}

export interface WorkflowParameters {
  fields: WorkflowField[];
  paramLayout?: WorkflowParamLayout;
  paramResolver?: { enabled: true };
  tools?: WorkflowTool[];
  tokenUsage?: { enabled: boolean; display?: boolean };
}

export interface WorkflowExecution {
  kind: 'sequence';
  children: WorkflowExecutionItem[];
}
export type WorkflowExecutionItem =
  | { kind: 'node'; nodeId: string; callId: string; standardName?: string; [key: string]: unknown }
  | { kind: 'branch'; branchId: string; label?: string; condition?: string; decision?: Extract<WorkflowExecutionItem, { kind: 'node' }>; branches: { label?: string; condition?: string; kind: string; children: WorkflowExecutionItem[] }[] }
  | { kind: 'loop'; loopId: string; label?: string; condition?: string; decision?: Extract<WorkflowExecutionItem, { kind: 'node' }>; children: WorkflowExecutionItem[] };

export interface WorkflowEntrypoint extends WorkflowParameters {
  id: string;
  title?: string;
  description?: string;
  group?: { id: string; title: string; order?: number };
  execution?: WorkflowExecution;
}

export interface WorkflowParamRequest {
  draftText: string;
  args: string[];
  inputMode: 'form' | 'raw';
  trigger: { kind: 'init' | 'input' } | { kind: 'param'; paramName: string };
}

export interface WorkflowProject extends WorkflowParameters {
  id: string;
  uri: string;
  folderPath: string;
  name: string;
  manifest?: { name?: string; version?: string; description?: string };
  projectType: WorkflowProjectType;
  entrypoints: WorkflowEntrypoint[];
  execution?: WorkflowExecution;
  definitions?: { nodes: Record<string, { name?: string; standardName?: string; [key: string]: unknown }>; [key: string]: unknown };
  diagnostics?: { warnings?: { message: string }[]; violations?: { message: string }[] };
  defaultEntrypoint?: string;
  artifactEntry?: string;
  kanban?: KanbanArtifactConfig;
  projectInfo?: WorkflowProjectInfo;
  requiresLogin?: boolean;
  assistant?: { workdir: string; roots: AssistantWorkspaceFolder[]; standalone?: boolean };
  conversation?: {
    commands?: ConversationCommandDefinition[];
    footer?: ConversationFooterItem[];
    userInput?: {
      hideComposer?: boolean;
      effects?: {
        when: { type?: string; nodeName?: string; values?: Record<string, string | number | boolean | string[]> };
        params: WorkflowParamValues;
      }[];
    };
    attachments?: { images?: boolean; videos?: boolean; files?: boolean };
    inputQueue?: { enabled?: boolean };
    recovery?: { enabled: true };
    durable?: { enabled: true };
  };
}

export interface ConversationCommandDefinition {
  command: string;
  label: string;
  description?: string;
  localizedLabel?: Record<string, string>;
  localizedDescription?: Record<string, string>;
  action: { kind: 'prompt'; text: string } | { kind: 'export' };
}

export interface ConversationFooterItem {
  text?: string;
  localizedText?: Record<string, string>;
  param?: string;
  when?: { param: string; value: string };
}

export interface AssistantWorkspaceFolder { uri: string; folderPath: string; name: string }

export interface WorkflowTool { name: string; label?: string; description?: string; enabled?: boolean; autoApprove?: boolean }
export type WorkflowToolPolicies = Record<string, { enabled?: boolean; autoApprove?: boolean }>;
export interface WorkflowAttachment {
  id: string; name: string; mimeType: string; size: number; kind: 'image' | 'file';
  storage: 'local' | 'server'; workflowId?: string; conversationId?: string; createdAt: string;
  path?: string; url?: string; previewUrl?: string;
}
export interface WorkflowUpload { name: string; mimeType?: string; data?: string; path?: string }
export interface WorkflowInputRequest {
  requestId: string; nodeName: string; title: string; description?: string; params: WorkflowField[];
  defaultValues?: Record<string, unknown>; createdAt?: string;
  metadata?: { type?: string; toolName?: string; toolArguments?: unknown; [key: string]: unknown };
}
export interface WorkflowResolvedInput { requestId: string; nodeName: string; values: Record<string, unknown>; submittedAt: string; request?: WorkflowInputRequest; precedingOutputItemIds?: string[] }

export interface WorkflowOutputItem {
  id?: string;
  title?: string;
  content: unknown;
  contentType?: string;
  display?: { type: 'ring'; placement?: 'inline' | 'composer-right' };
  collapsed?: boolean;
  metadata?: Record<string, unknown>;
}

export interface WorkflowTimerRecord {
  timerId: string; title: string; startedAt: string; endedAt?: string; durationMs?: number;
  status: 'running' | 'success' | 'failed' | 'cleared'; message?: string;
}

export interface WorkflowReport {
  status: string;
  durationMs?: number;
  output?: { items?: WorkflowOutputItem[] };
  result?: { success?: boolean; data?: unknown; error?: { message?: string } };
  runId?: string;
  pendingUserInput?: WorkflowInputRequest;
  resolvedUserInputs?: WorkflowResolvedInput[];
  tokenUsage?: { enabled: true; display: boolean; run: Record<string, unknown> };
  nodes?: Record<string, unknown>[];
  logs?: string;
  files?: WorkflowAttachment[];
  timers?: WorkflowTimerRecord[];
  [key: string]: unknown;
}

export interface WorkflowRun {
  agentCommands?: { command: AgentSessionCommand; scopeId: string; attachments?: WorkflowAttachment[] }[];
  project: WorkflowProject;
  conversationId: string;
  args: string[];
  entrypointId?: string;
  runId?: string;
  resolvedInputs?: WorkflowResolvedInput[];
  resumeAfterRequestId?: string;
  toolPermissionPolicies?: WorkflowToolPolicies;
}

export interface WorkflowRuntime {
  agentControl?(runId: string, command: AgentSessionCommand, scopeId: string, attachments?: WorkflowAttachment[]): Promise<AgentSessionReceipt>;
  available: boolean;
  kanbanBridge?(project: WorkflowProject, call: KanbanBridgeCall): Promise<unknown>;
  inspect(paths: string[]): Promise<{ projects: Omit<WorkflowProject, 'uri'>[]; errors: string[] }>;
  resolveParams(project: WorkflowProject, request: WorkflowParamRequest, entrypointId?: string): Promise<{ params?: Record<string, WorkflowParamState> }>;
  run(request: WorkflowRun, onEvent: (event: Record<string, unknown>) => void): Promise<WorkflowReport>;
  uploadFiles(project: WorkflowProject, conversationId: string, files: WorkflowUpload[]): Promise<WorkflowAttachment[]>;
  readFile(project: WorkflowProject, id: string): Promise<{ reference: WorkflowAttachment; path: string }>;
  deleteFiles(project: WorkflowProject, conversationId: string, ids: string[]): Promise<void>;
  readResource(project: WorkflowProject, conversationId: string, kind: 'kv' | 'knowledge', target: Record<string, string>): Promise<unknown>;
  deleteConversation(project: WorkflowProject, conversationId: string): Promise<void>;
  cancelConversation(project: WorkflowProject, conversationId: string): Promise<void>;
  cancel(runId?: string): void;
  dispose(): void;
}

export interface ConversationMessage {
  contextEpoch?: number;
  sessionRequestId?: string;
  sessionConversationId?: number;
  entryId?: number;
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  items?: WorkflowOutputItem[];
  error?: string;
  status?: string;
  recovering?: boolean;
  cancelRequested?: boolean;
  recoveryAttempts?: number;
  durationMs?: number;
  createdAt?: number;
  model?: string;
  attachments?: WorkflowAttachment[];
  args?: string[];
  entrypointId?: string;
  runId?: string;
  pendingInput?: WorkflowInputRequest;
  resolvedInputs?: WorkflowResolvedInput[];
  submittingInput?: WorkflowResolvedInput;
  tokenUsage?: WorkflowReport['tokenUsage'];
  report?: WorkflowReport;
  events?: Record<string, unknown>[];
  input?: Omit<ConversationQueuedInput, 'id' | 'createdAt'>;
  files?: WorkflowAttachment[];
  timers?: WorkflowTimerRecord[];
}

export interface ConversationQueuedInput { id: string; requestId?: string; text: string; params: WorkflowParamValues; states?: Record<string, WorkflowParamState>; entrypointId?: string; attachments: WorkflowAttachment[]; createdAt: number }

export interface ConversationSession {
  agentParameters?: { args: string[]; entrypointId?: string; policies: unknown };
  agent?: AgentSessionSnapshot;
  agentOwnerId?: string;
  agentConversationId?: number;
  forkSource?: { sessionId: string; entryId: number };
  agentCommands?: { command: AgentSessionCommand; scopeId: string; attachments?: WorkflowAttachment[] }[];
  /** Presentation metadata only; Harness owns input scheduling and consumption. */
  agentInputs?: Record<string, ConversationQueuedInput>;
  id: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  messages: ConversationMessage[];
  parameterValues?: Record<string, WorkflowParamValues>;
  parameterRevisions?: Record<string, Record<string, string>>;
  toolPermissionPolicies?: WorkflowToolPolicies;
  queuedInputs?: ConversationQueuedInput[];
  draft?: { text: string; attachments: WorkflowAttachment[]; editingQueueId?: string };
  titleLocked?: boolean;
  activeRunId?: string;
}

export interface ConversationDraftUpdate { id: string; create?: boolean; draft: NonNullable<ConversationSession['draft']> }

export function sessionRunning(session: ConversationSession): boolean {
  if (!session.agent) return !!session.activeRunId;
  const id = session.agentConversationId ?? session.agent.conversationId;
  const context = session.agent.contexts.find(context => context.conversationId === id);
  if (context) return context.foreground;
  return id === session.agent.conversationId ? session.agent.foreground : session.agent.turns.some(turn => turn.conversationId === id && turn.status === 'placed');
}

export const projectTypeLabels: Record<WorkflowProjectType, string> = {
  get conversation() { return t("Conversation"); },
  get workflow() { return t("Workflow"); },
  get kanban() { return t("Kanban"); },
};

export function workflowParameters(project: WorkflowProject, entrypointId?: string): WorkflowParameters {
  return project.entrypoints.find((entry) => entry.id === entrypointId) ?? project;
}

export function workflowParamValue(field: WorkflowField, value: WorkflowParamValue = field.defaultValue ?? ''): WorkflowParamValue {
  if (field.type === 'file' || field.control === 'audio' || !(field.multiple || field.control === 'checkboxes') || Array.isArray(value)) { return value; }
  if (!value.trim()) { return []; }
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) { return parsed.filter((entry) => ['string', 'number', 'boolean'].includes(typeof entry)).map(String); }
  } catch { /* A single selection can also be an ordinary string. */ }
  return [value];
}

export function workflowFormValue(field: WorkflowField, value: unknown): WorkflowParamValue {
  if (value === undefined || value === null) { return workflowParamValue(field); }
  if (typeof value === 'string') { return workflowParamValue(field, value); }
  if (field.type === 'file' || field.control === 'audio' || field.format === 'json') { return JSON.stringify(value); }
  return workflowParamValue(field, Array.isArray(value) ? value.map(String) : String(value));
}

export function workflowParamArgs(fields: WorkflowField[], values: WorkflowParamValues, states: Record<string, WorkflowParamState> = {}): string[] {
  const args: string[] = [];
  for (const field of fields) {
    if (states[field.name]?.visible === false) { continue; }
    const value = workflowParamValue(field, values[field.name]);
    const entries = Array.isArray(value) ? value.length ? [JSON.stringify(value)] : [] : [value];
    for (const entry of entries) {
      if (entry === '') { continue; }
      if (field.flag) { args.push(field.flag, entry); }
      else if (field.type === 'positional') { args.push(entry); }
    }
  }
  return args;
}

export function applyOutputChunk(items: WorkflowOutputItem[], value: unknown): void {
  if (!value || typeof value !== 'object') { return; }
  const chunk = value as { type?: string; item?: WorkflowOutputItem; itemId?: string; delta?: unknown };
  if (chunk.type === 'output_item_start' && chunk.item) {
    const index = items.findIndex((item) => item.id && item.id === chunk.item?.id);
    if (index >= 0) { items[index] = { ...chunk.item }; }
    else { items.push({ ...chunk.item }); }
  } else if (chunk.type === 'output_item_delta') {
    const item = items.find((entry) => entry.id === chunk.itemId);
    if (item) {
      if (chunk.item) {
        const { metadata, ...patch } = chunk.item;
        Object.assign(item, patch);
        if (metadata !== undefined) { item.metadata = { ...item.metadata, ...metadata }; }
      }
      if (typeof chunk.delta === 'string') { item.content = `${typeof item.content === 'string' ? item.content : ''}${chunk.delta}`; }
      else if (Array.isArray(item.content) && Array.isArray(chunk.delta)) { item.content = [...item.content, ...chunk.delta]; }
      else if (item.content !== null && typeof item.content === 'object' && chunk.delta !== null && typeof chunk.delta === 'object') {
        item.content = { ...item.content, ...chunk.delta };
      }
      else if (chunk.delta !== undefined) { item.content = chunk.delta; }
    }
  }
}

export function outputText(items: WorkflowOutputItem[]): string {
  return items.filter((item) => !item.collapsed && item.metadata?.plan !== true && ['text', 'markdown', undefined].includes(item.contentType))
    .map((item) => typeof item.content === 'string' ? item.content : '').filter(Boolean).join('\n\n');
}

export function validateWorkflowValues(fields: WorkflowField[], values: WorkflowParamValues, states: Record<string, WorkflowParamState> = {}): void {
  for (const field of fields) {
    if (states[field.name]?.visible === false || states[field.name]?.disabled) { continue; }
    const value = workflowParamValue(field, values[field.name]);
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

export function validateConversationCommandStates(fields: WorkflowField[], states: Record<string, WorkflowParamState>, definitions: ConversationCommandDefinition[] = []): void {
  const commands = definitions.map(definition => definition.command);
  for (const field of fields.filter(field => field.panel === 'slash')) {
    commands.push(...(field.type === 'boolean' ? [field.command ?? field.name]
      : (states[field.name]?.resolvedOptions ?? field.options ?? []).map(option =>
          option.command ?? field.options?.find(original => original.value === option.value)?.command ?? option.value)));
  }
  const seen = new Set<string>();
  for (const command of commands) {
    if (!/^[a-z][a-z0-9_-]*$/.test(command) || seen.has(command)) { throw new Error(t("Slash command \"{0}\" must be unique and use lowercase letters, digits, underscores or hyphens.", command)); }
    seen.add(command);
  }
}

export function mergeWorkflowParamStates(states: Record<string, WorkflowParamState>, patches: Record<string, WorkflowParamState> = {}): Record<string, WorkflowParamState> {
  const next = { ...states };
  for (const [name, patch] of Object.entries(patches)) {
    const options: NonNullable<WorkflowParamState['options']> = patch.resolvedOptions === undefined ? { ...states[name]?.options } : {};
    for (const [value, option] of Object.entries(patch.options ?? {})) {
      options[value] = { ...options[value], ...option };
    }
    next[name] = { ...states[name], ...patch, options };
  }
  return next;
}

export function resolvedWorkflowValues(fields: WorkflowField[], values: WorkflowParamValues): Record<string, unknown> {
  validateWorkflowValues(fields, values);
  return Object.fromEntries(fields.map((field) => {
    const value = workflowParamValue(field, values[field.name]);
    if (field.type === 'boolean') { return [field.name, value === 'true']; }
    if (field.type === 'number' && value !== '') { return [field.name, Number(value)]; }
    if ((field.type === 'file' || field.control === 'audio' || field.format === 'json') && typeof value === 'string' && value !== '') { return [field.name, JSON.parse(value)]; }
    return [field.name, value];
  }));
}

export function redactWorkflowData(value: unknown, secrets: string[] = [], redactKeys = true): unknown {
  if (typeof value === 'string') { for (const secret of secrets.filter(Boolean)) { value = (value as string).replaceAll(secret, '[redacted]'); } return value; }
  if (Array.isArray(value)) { return value.map((entry) => redactWorkflowData(entry, secrets, redactKeys)); }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      redactKeys && /password|secret|authorization|cookie|^(?:api[-_]?key|access[-_]?token|refresh[-_]?token)$/i.test(key) ? '[redacted]' : redactWorkflowData(entry, secrets, redactKeys)]));
  }
  return value;
}
