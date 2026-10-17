import { t } from './localization';
import type { ConversationMessage, WorkflowOutputItem } from '../src/workflow-types';

export type ActivityStatus = 'running' | 'success' | 'failed' | 'stopped' | 'waiting';
export interface AgentActivity {
  kind: string;
  icon: string;
  status: ActivityStatus;
  action: string;
  target?: string;
  label: string;
  title: string;
  sections: { label: string; value: unknown; error?: boolean }[];
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const first = (value: Record<string, unknown>, ...keys: string[]): string | undefined => keys.map((key) => text(value[key])).find(Boolean);
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
const matches = (tool: string, ...names: string[]): boolean => names.some((name) => tool === name || tool.endsWith(`_${name}`));

function toolAction(toolName: string, input: Record<string, unknown>): Pick<AgentActivity, 'kind' | 'icon' | 'action' | 'target'> {
  const tool = toolName.toLowerCase().replace(/[-.]/g, '_');
  const path = first(input, 'filePath', 'file_path', 'path', 'file');
  const directory = first(input, 'path', 'directory', 'dir', 'workdir', 'cwd');
  const query = first(input, 'pattern', 'query', 'search', 'text');
  if (matches(tool, 'read')) { return { kind: 'read', icon: 'book', action: t("Read"), target: path ?? t("File") }; }
  if (matches(tool, 'grep', 'glob', 'search', 'codesearch', 'code_search')) {
    const quoted = query && `\u201c${query}\u201d`;
    return { kind: 'search', icon: 'search', action: t("Search"), target: directory && quoted ? t("{1} in {0}", directory, quoted) : directory || quoted || t("File") };
  }
  if (matches(tool, 'list', 'ls')) { return { kind: 'list', icon: 'folder-opened', action: t("List"), target: directory ? t("Files in {0}", directory) : t("File") }; }
  if (matches(tool, 'bash', 'shell', 'command', 'exec', 'execute', 'exec_command')) {
    return { kind: 'command', icon: 'terminal', action: t("Run"), target: first(input, 'command', 'cmd', 'script') ?? t("Command") };
  }
  if (matches(tool, 'edit', 'replace', 'edit_file')) { return { kind: 'edit', icon: 'edit', action: t("Edit"), target: path ?? t("File") }; }
  if (matches(tool, 'write', 'create_file', 'write_file')) { return { kind: 'write', icon: 'new-file', action: t("Write"), target: path ?? t("File") }; }
  if (matches(tool, 'patch', 'apply_patch', 'multiedit', 'multi_edit')) { return { kind: 'patch', icon: 'diff', action: t("Apply changes"), target: path }; }
  if (matches(tool, 'websearch', 'web_search')) { return { kind: 'web', icon: 'globe', action: t("Search web"), target: query }; }
  if (matches(tool, 'webfetch', 'web_fetch', 'fetch')) { return { kind: 'web', icon: 'globe', action: t("Read web page"), target: first(input, 'url', 'uri') }; }
  if (matches(tool, 'todowrite', 'todo_write', 'todoread', 'todo_read')) { return { kind: 'todo', icon: 'checklist', action: t("Update tasks") }; }
  if (matches(tool, 'task', 'subtask', 'agent')) { return { kind: 'task', icon: 'hubot', action: t("Run subtask"), target: first(input, 'description', 'title', 'prompt') }; }
  if (matches(tool, 'question')) { return { kind: 'question', icon: 'comment-discussion', action: t("Ask"), target: first(input, 'title', 'question') }; }
  if (tool.includes('knowledge_documents') || tool.includes('global_memory')) {
    const action = first(input, 'action');
    return { kind: 'knowledge', icon: 'book', action: action === 'search' ? t("Search knowledge") : ['create', 'update', 'delete'].includes(action ?? '') ? t("Update knowledge") : t("Read knowledge"), target: first(input, 'title', 'documentId', 'memoryId', 'query') };
  }
  if (tool.includes('kv_store')) { return { kind: 'storage', icon: 'database', action: ['set', 'delete'].includes(String(input.action)) ? t("Update data") : t("Read data"), target: first(input, 'key', 'scope') }; }
  return { kind: 'tool', icon: 'tools', action: t("Call tool"), target: toolName };
}

function activityStatus(value: unknown, message?: ConversationMessage): ActivityStatus {
  const status = ['running', 'pending', 'in_progress'].includes(String(value)) ? 'running'
    : ['failed', 'error'].includes(String(value)) ? 'failed'
      : ['aborted', 'cancelled', 'canceled', 'cleared'].includes(String(value)) ? 'stopped' : 'success';
  if (status !== 'running' || !message) { return status; }
  if (message.pendingInput || message.status === 'waiting_for_input') { return 'waiting'; }
  if (message.status === 'failed' || message.status === 'timed_out') { return 'failed'; }
  if (message.status && message.status !== 'running') { return 'stopped'; }
  return status;
}

function statusTitle(action: string, target: string | undefined, status: ActivityStatus): string {
  const label = status === 'running' ? t("{0}...", action) : status === 'waiting' ? t("Awaiting confirmation: {0}", action)
    : status === 'failed' ? t("{0} failed", action) : status === 'stopped' ? t("Stopped {0}", action) : action === t("Thinking") ? t("Thought complete") : t("{0}", action);
  return normalize([label, target].filter(Boolean).join(' '));
}

// Agent and OpenCode use the same structured activity contract as Desktop.
export function agentActivity(item: WorkflowOutputItem, message?: ConversationMessage): AgentActivity | undefined {
  const kind = item.metadata?.kind;
  const extraTypes: Record<string, string> = { 'agent-error': 'error', 'opencode-error': 'error', 'opencode-retry': 'retry', 'opencode-diff': 'patch', 'opencode-todo': 'todo', 'opencode-stream-recovery': 'stream_recovery' };
  if (!['agent-part', 'opencode-part'].includes(String(kind)) && !extraTypes[String(kind)]) { return; }
  let content = record(item.content);
  if (!content && typeof item.content === 'string') { try { content = record(JSON.parse(item.content)); } catch { return; } }
  if (!content) { return; }
  const type = extraTypes[String(kind)] ?? item.metadata?.partType ?? content.type;
  if (type === 'text' || type === 'plan') { return; }
  const status = activityStatus(item.metadata?.status ?? content.status, message);
  const sections: AgentActivity['sections'] = [];
  let descriptor: Pick<AgentActivity, 'kind' | 'icon' | 'action' | 'target'>;
  if (type === 'tool') {
    const input = record(content.input) ?? {};
    descriptor = toolAction(text(content.tool) ?? item.title ?? 'tool', input);
    if (Object.keys(input).length) { sections.push({ label: t("Parameters"), value: input }); }
    else if (content.rawInput !== undefined) { sections.push({ label: t("Parameters"), value: content.rawInput }); }
    if (content.output !== undefined) { sections.push({ label: t("Result"), value: content.output }); }
    if (content.error !== undefined) { sections.push({ label: t("Error"), value: content.error, error: true }); }
    if (Array.isArray(content.attachments) && content.attachments.length) { sections.push({ label: t("Attachment"), value: content.attachments }); }
  } else {
    const descriptors: Record<string, Pick<AgentActivity, 'kind' | 'icon' | 'action'>> = {
      reasoning: { kind: 'reasoning', icon: 'lightbulb', action: t("Thinking") },
      retry: { kind: 'retry', icon: 'refresh', action: t("Retry") },
      stream_recovery: { kind: 'retry', icon: 'refresh', action: t("Reconnect") },
      compaction: { kind: 'compaction', icon: 'fold', action: t("Compact context") },
      patch: { kind: 'patch', icon: 'diff', action: t("Apply changes") },
      file: { kind: 'file', icon: 'file', action: t("Generated file") },
      todo: { kind: 'todo', icon: 'checklist', action: t("Update tasks") },
      agent: { kind: 'task', icon: 'hubot', action: t("Run subtask") },
      subtask: { kind: 'task', icon: 'hubot', action: t("Run subtask") },
      error: { kind: 'error', icon: 'error', action: t("Agent run") },
    };
    descriptor = descriptors[String(type)];
    if (!descriptor) { return; }
    const value = type === 'reasoning' ? content.text : content;
    if (value !== undefined && value !== '') {
      sections.push({ label: type === 'reasoning' ? t("Reasoning") : type === 'error' ? t("Error") : t("Details"), value, error: type === 'error' });
    }
    if (type === 'retry') { descriptor = { ...descriptor, target: content.attempt ? `${content.attempt}${content.maxAttempts ? ` / ${content.maxAttempts}` : ''}` : undefined }; }
    if (type === 'file') { descriptor = { ...descriptor, target: first(content, 'filename', 'path', 'name') }; }
  }
  const resolvedStatus = type === 'error' ? 'failed' : status;
  return { ...descriptor, status: resolvedStatus, label: statusTitle(descriptor.action, undefined, resolvedStatus), title: statusTitle(descriptor.action, descriptor.target, resolvedStatus), sections };
}

export function activeAgentActivity(message: ConversationMessage): AgentActivity | undefined {
  for (const item of [...(message.items ?? [])].reverse()) {
    const activity = agentActivity(item, message);
    if (activity?.status === 'running' || activity?.status === 'waiting') { return activity; }
  }
}

export function activityGroupSummary(activities: AgentActivity[]): { title: string; status: ActivityStatus } {
  const active = [...activities].reverse().find((activity) => activity.status === 'running' || activity.status === 'waiting');
  const completed = activities.filter((activity) => activity.status === 'success').length;
  if (active) { return { title: t("{0} \u00B7 {1}/{2} items", statusTitle(active.action, undefined, active.status), completed, activities.length), status: active.status }; }
  const failures = activities.filter((activity) => activity.status === 'failed').length;
  const stopped = activities.some((activity) => activity.status === 'stopped');
  const labels: Record<string, string> = { read: t("Read file"), search: t("Search content"), list: t("List files"), command: t("Run command"), edit: t("Edit file"), write: t("Write file"), patch: t("Apply changes") };
  const actions = [...new Set(activities.map((activity) => labels[activity.kind] ?? activity.action))];
  const title = failures ? t("Run records \u00B7 {0} items, {1} failed", activities.length, failures)
    : stopped ? t("Stopped \u00B7 {0}/{1} items completed", completed, activities.length)
      : t("{0}{1} \u00B7 {2} items", actions.slice(0, 3).join(t(", ")), actions.length > 3 ? t(" and others") : '', activities.length);
  return { title, status: failures ? 'failed' : stopped ? 'stopped' : 'success' };
}

export function activityValueText(value: unknown): string {
  if (typeof value === 'string') { return value; }
  const output = record(value);
  if (Array.isArray(output?.content) && output.content.length > 0 && output.content.every((part) => record(part)?.type === 'text' && typeof record(part)?.text === 'string')) {
    return output.content.map((part) => record(part)!.text).join('\n\n') + (output.details !== undefined ? `\n\n${JSON.stringify(output.details, null, 2)}` : '');
  }
  return JSON.stringify(value, null, 2) ?? '';
}
