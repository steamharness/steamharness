import { t } from './localization';
import { agentActivity, activityValueText } from './agent-activity';
import type { ConversationMessage, OutputItem } from '../src/workflow-types';
import type { TraceRun, TraceSnapshot, TraceSelection } from '../src/workflow-trace-types';

export type TraceLane = 'input' | 'model' | 'tool' | 'node' | 'output' | 'log';
export interface TraceRow {
  id: string; turn: number; lane: TraceLane; label: string; title: string; preview: string; status?: string;
  start?: number; end?: number; durationMs?: number;
  sections: { label: string; value: string; error?: boolean }[];
}
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export function traceTime(value: unknown): number | undefined {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
}
export function traceDuration(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) { return ''; }
  if (value < 1000) { return `${Math.max(0, Math.round(value))} ms`; }
  if (value < 60_000) { return `${(value / 1000).toFixed(1)} s`; }
  return `${Math.floor(value / 60_000)} m ${Math.round(value % 60_000 / 1000)} s`;
}
function valueText(value: unknown): string {
  const content = record(value);
  return content.type === 'text' && typeof content.text === 'string' ? content.text : activityValueText(value);
}
function terminalStatus(status: string | undefined, parent: string | undefined): string | undefined {
  if (!['running', 'pending', 'in_progress', 'waiting_for_input', 'waiting'].includes(status ?? '') || !parent || parent === 'running') { return status; }
  return parent === 'waiting_for_input' ? 'waiting' : ['failed', 'timed_out'].includes(parent) ? 'failed' : 'stopped';
}
function runRows(run: TraceRun, turn: number, conversation = false): TraceRow[] {
  const prefix = `${run.id}:`, rows: TraceRow[] = [], nodes = new Map<string, Record<string, any>>();
  const itemTimes = new Map<string, { start?: number; end?: number }>();
  for (const event of run.events ?? []) {
    if (event.type === 'node_started' || event.type === 'node_finished') {
      const id = String(event.executionId ?? ''); nodes.set(id, { ...nodes.get(id), ...event, name: event.nodeName, status: event.status ?? 'running' });
    }
    if (event.type === 'node_chunk') {
      const chunk = record(event.chunk), id = chunk.item?.id ?? chunk.itemId;
      if (typeof id !== 'string') { continue; }
      const time = itemTimes.get(id) ?? {};
      if (chunk.type === 'output_item_start') { time.start ??= traceTime(event.timestamp); }
      if (chunk.type === 'output_item_end') { time.end = traceTime(event.timestamp); }
      itemTimes.set(id, time);
    }
  }
  for (const [index, node] of (run.report?.nodes ?? run.nodes ?? []).entries()) {
    const id = String(node.executionId ?? `node-${index}`); nodes.set(id, { ...nodes.get(id), ...node });
  }
  for (const [id, node] of nodes) {
    const start = traceTime(node.startedAt), end = traceTime(node.endedAt), sections: TraceRow['sections'] = [];
    for (const [key, label] of [['input', t("Input")], ['output', t("Output")], ['error', t("Error")], ['executionInfo', t("Execution information")]]) {
      if (node[key] !== undefined) { sections.push({ label, value: valueText(node[key]), error: key === 'error' }); }
    }
    const lane = /^(llm|llm-stream|model|agent|opencode)$/i.test(String(node.metadata?.type ?? node.kind)) ? 'model' : 'node';
    rows.push({ id: `${prefix}node:${id}`, turn, lane, label: lane === 'model' ? t("Model") : t("Node"),
      title: String(node.metadata?.title ?? node.name ?? node.nodeName ?? node.kind ?? id), preview: sections[0]?.value ?? '',
      status: terminalStatus(node.status, run.status), start, end,
      durationMs: typeof node.durationMs === 'number' ? node.durationMs : start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined, sections });
  }
  const message: ConversationMessage = { role: 'assistant', content: '', status: run.status, pendingInput: run.pendingInput };
  for (const [index, item] of (run.items ?? run.report?.output?.items ?? []).entries()) {
    const activity = agentActivity(item, message), content = record(item.content);
    const timing = itemTimes.get(item.id ?? '') ?? {};
    const start = traceTime(content.startedAt ?? item.metadata?.startedAt) ?? timing.start;
    const end = traceTime(content.endedAt ?? item.metadata?.endedAt) ?? timing.end;
    const tool = content.type === 'tool' || item.metadata?.partType === 'tool';
    const lane = tool ? 'tool' : activity ? activity.kind === 'reasoning' ? 'model' : 'node' : 'output';
    const sections = activity?.sections.map(section => ({ ...section, value: valueText(section.value) })) ?? [{ label: t("Content"), value: valueText(item.content) }];
    const rawTitle = tool ? String(content.tool ?? item.title ?? t("Tool")) : activity?.title ?? item.title ?? (conversation ? t("Assistant") : t("Output"));
    rows.push({ id: `${prefix}item:${item.id ?? index}`, turn, lane, label: tool ? t("Tool") : activity ? activity.action : conversation ? t("Assistant") : t("Output"),
      title: rawTitle, preview: sections.map(section => section.value).join(' \u2192 '), status: activity?.status ?? run.status,
      start, end, durationMs: start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined, sections });
  }
  for (const input of run.resolvedInputs ?? []) {
    rows.push({ id: `${prefix}input:${input.requestId}`, turn, lane: 'input', label: t("Confirm"), title: input.request?.title ?? input.nodeName,
      preview: valueText(input.values), start: traceTime(input.submittedAt), status: 'success', sections: [{ label: t("Input"), value: valueText(input.values) }] });
  }
  if (run.pendingInput) {
    const input = run.pendingInput;
    rows.push({ id: `${prefix}input:${input.requestId}`, turn, lane: 'input', label: t("Waiting"), title: input.title,
      preview: input.description ?? '', start: traceTime(input.createdAt), status: 'waiting', sections: [{ label: t("Request"), value: valueText(input) }] });
  }
  const logs = run.logs ?? run.report?.logs ?? (run.events ?? []).filter(event => event.type === 'runtime_log').map(event => event.text ?? '').join('');
  if (logs) { rows.push({ id: `${prefix}logs`, turn, lane: 'log', label: t("Logs"), title: t("Run logs"), preview: logs,
    sections: [{ label: t("Logs"), value: logs }] }); }
  if (run.error) { rows.push({ id: `${prefix}error`, turn, lane: 'log', label: t("Error"), title: t("Run failed"), preview: run.error,
    status: 'failed', sections: [{ label: t("Error"), value: run.error, error: true }] }); }
  return rows;
}
export function traceRows(snapshot: TraceSnapshot | undefined, selection: TraceSelection, selectedRun?: TraceRun): TraceRow[] {
  if (!snapshot) { return []; }
  if (snapshot.project.projectType === 'workflow') {
    const run = selectedRun ?? (selection.runId ? [snapshot.run, snapshot.occupiedRun].find(run => run?.id === selection.runId) : snapshot.run ?? snapshot.occupiedRun);
    if (!run) { return []; }
    const input = valueText(run.params ?? run.args ?? []);
    return [{ id: `${run.id}:input`, turn: 1, lane: 'input', label: t("Input"), title: run.title, preview: input, start: run.createdAt,
      sections: [{ label: t("Parameters"), value: input }] }, ...runRows(run, 1)];
  }
  const session = snapshot.sessions?.find(session => session.id === (selection.sessionId ?? snapshot.activeId));
  if (!session) { return []; }
  const rows: TraceRow[] = []; let turn = 0, input: ConversationMessage | undefined;
  for (const [index, message] of session.messages.entries()) {
    if (message.role === 'user') { input = message; ++turn; if (selection.messageId || selection.runId) { continue; } }
    else if (selection.messageId ? message.id !== selection.messageId : selection.runId && message.runId !== selection.runId) { continue; }
    const addInput = (user: ConversationMessage) => rows.push({ id: `${session.id}:user:${user.id ?? index}`, turn,
      lane: 'input', label: t("User"), title: t("Input"), preview: user.content, start: user.createdAt,
      sections: [{ label: t("Content"), value: user.content }] });
    if (message.role === 'user') { addInput(message); continue; }
    if ((selection.messageId || selection.runId) && input) { addInput(input); }
    const items: OutputItem[] = message.items ?? message.report?.output?.items ?? (message.content ? [{ content: message.content }] : []);
    rows.push(...runRows({ ...message, id: message.id ?? String(index), title: message.model ?? t("Assistant"), status: message.status ?? 'success', items,
      resolvedInputs: message.resolvedInputs ?? message.report?.resolvedUserInputs }, turn, true));
  }
  return rows;
}
export function filterTraceRows(rows: TraceRow[], query: string, mode: string): TraceRow[] {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter(row => (mode !== 'calls' || ['tool', 'node', 'model'].includes(row.lane))
    && (!search || [row.title, row.label, row.preview, ...row.sections.map(section => section.value)].join(' ').toLocaleLowerCase().includes(search)));
}
