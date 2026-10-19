import { Controller } from './workflow-controller';
import { parseWorkflowArgs, type Draft } from './workflow-workspace';
import {
  workflowParameters, workflowParamArgs, workflowParamValue, redactWorkflowData,
  type Runtime, type Project, type ParamState, type ParamValues,
} from './workflow-types';

type Message = Record<string, any>;
export function createWorkflowActions(controller: Controller, runtime: Runtime, project: Project, revision: () => number, changed: () => void) {
  const states = new Map<string, Record<string, ParamState>>();
  const epochs = new Map<string, number>();
  let limit = 30, query = '';
  const entry = (id: unknown): string | undefined => {
    const value = typeof id === 'string' && id ? id : project.defaultEntrypoint ?? project.entrypoints[0]?.id;
    if (value && !project.entrypoints.some(item => item.id === value)) { throw new Error('Unknown entrypoint.'); }
    return value;
  };
  const values = (supplied: unknown, id?: string): ParamValues => {
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
      || Object.values(supplied).some(value => typeof value !== 'string' && !(Array.isArray(value) && value.every(item => typeof item === 'string')))) { throw new Error('Invalid parameters.'); }
    return Object.fromEntries(workflowParameters(project, id).fields.map(field => [field.name,
      workflowParamValue(field, (supplied as ParamValues)[field.name] ?? field.defaultValue ?? (field.type === 'boolean' ? 'false' : ''))]));
  };
  const resolve = async (message: Message, id?: string) => {
    const key = id ?? '', parameters = workflowParameters(project, id);
    const params = values(message.params ?? controller.draft(id).values, id);
    const mode = message.inputMode === 'raw' ? 'raw' as const : 'form' as const;
    const epoch = (epochs.get(key) ?? 0) + 1; epochs.set(key, epoch);
    const auth = revision();
    await controller.updateDraft(id, { values: params, rawArgs: String(message.rawArgs ?? controller.draft(id).rawArgs).slice(0, 100_000), inputMode: mode });
    const args = mode === 'raw' ? parseWorkflowArgs(String(message.rawArgs ?? '[]')) : workflowParamArgs(parameters.fields, params, states.get(key));
    const trigger = message.trigger?.kind === 'param' && parameters.fields.some(field => field.name === message.trigger.paramName)
      ? { kind: 'param' as const, paramName: String(message.trigger.paramName) } : { kind: message.trigger?.kind === 'input' ? 'input' as const : 'init' as const };
    const result = parameters.paramResolver?.enabled ? await runtime.resolveParams(project, { args, inputMode: mode, draftText: '', trigger }, id) : { params: {} };
    if (epoch !== epochs.get(key) || auth !== revision()) { throw new Error('Parameters changed. Try again.'); }
    const next = { ...(states.get(key) ?? {}) };
    for (const [name, patch] of Object.entries(result.params ?? {})) {
      if (!parameters.fields.some(field => field.name === name)) { continue; }
      next[name] = { ...next[name], ...patch, options: { ...next[name]?.options, ...patch.options } };
      if (patch.value !== undefined) { params[name] = patch.value === null ? workflowParamValue(parameters.fields.find(field => field.name === name)!) : patch.value; }
    }
    states.set(key, next);
    await controller.updateDraft(id, { values: params, rawArgs: String(message.rawArgs ?? controller.draft(id).rawArgs).slice(0, 100_000), inputMode: mode });
    return { params, states: next };
  };
  const state = () => {
    const filtered = controller.runs.filter(record => !query || `${record.title} ${record.entrypointId ?? ''} ${record.args.join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const runs = filtered.slice(0, limit).map(({ id, title, entrypointId, status, createdAt, updatedAt, durationMs }) => ({ id, title, entrypointId, status, createdAt, updatedAt, durationMs }));
    return { runs, selectedId: controller.workspace.selectedId, run: controller.current, occupiedId: controller.workspace.occupiedId,
      occupiedRun: controller.occupied, running: controller.running, drafts: controller.workspace.drafts,
      history: { pageSize: 30, total: filtered.length, hasMore: filtered.length > limit, query }, migratedConversations: controller.workspace.migratedConversations };
  };
  return {
    state,
    invalidate: () => { states.clear(); for (const [key, value] of epochs) { epochs.set(key, value + 1); } },
    async handle(message: Message): Promise<Message[]> {
      const replies: Message[] = [];
      const id = entry(message.entrypointId);
      if (message.projectUri && message.projectUri !== project.uri) { throw new Error('Project changed.'); }
      switch (message.type) {
        case 'ready': break;
        case 'workflow-history': {
          const nextQuery = String(message.query ?? '').slice(0, 200);
          if (query !== nextQuery || !message.more) { limit = 30; } else { limit = Math.min(limit + 30, 30_000); }
          query = nextQuery; changed(); break;
        }
        case 'workflow-select': await controller.select(message.id ? String(message.id) : undefined); break;
        case 'workflow-trace': {
          const run = controller.runs.find(record => record.id === message.id);
          if (!run) { throw new Error('Run no longer exists.'); }
          replies.push({ type: 'trace-run', runId: run.id, run }); break;
        }
        case 'workflow-draft': {
          const draft: Partial<Draft> = { values: values(message.params ?? {}, id) };
          if (message.inputMode !== undefined) { draft.inputMode = message.inputMode === 'raw' ? 'raw' : 'form'; }
          if (message.rawArgs !== undefined) { draft.rawArgs = String(message.rawArgs).slice(0, 100_000); }
          epochs.set(id ?? '', (epochs.get(id ?? '') ?? 0) + 1);
          await controller.updateDraft(id, draft); break;
        }
        case 'resolve': {
          try {
            const result = await resolve(message, id);
            replies.push({ type: 'params', projectUri: project.uri, entrypointId: id, requestId: message.requestId, params: result.states, values: result.params });
          } catch (error) { replies.push({ type: 'params', projectUri: project.uri, entrypointId: id, requestId: message.requestId, error: (error as Error).message }); }
          break;
        }
        case 'workflow-run': {
          if (controller.running) { throw new Error('A workflow is already running or waiting for input.'); }
          const resolved = await resolve(message, id);
          const record = await controller.start({ entrypointId: id, params: resolved.params, states: resolved.states,
            inputMode: message.inputMode === 'raw' ? 'raw' : 'form', rawArgs: String(message.rawArgs ?? '[]') });
          replies.push({ type: 'workflow-started', id: record.id }); break;
        }
        case 'workflow-stop': await controller.stop(); break;
        case 'workflow-resume': await controller.resume(String(message.id), String(message.requestId), message.values ?? {}); break;
        case 'workflow-rerun': await controller.rerun(String(message.id)); break;
        case 'workflow-delete': await controller.remove(String(message.id)); break;
        case 'workflow-export': {
          const record = controller.runs.find(record => record.id === message.id);
          if (!record) { throw new Error('Run no longer exists.'); }
          replies.push({ type: 'download', name: `workflow-${record.id}.json`, content: JSON.stringify(redactWorkflowData(record, [], false), null, 2) }); break;
        }
        case 'tool-policy': {
          const tools = workflowParameters(project, id).tools ?? [];
          const policies = Object.fromEntries(tools.map(tool => [tool.name, {
            enabled: typeof message.policies?.[tool.name]?.enabled === 'boolean' ? message.policies[tool.name].enabled : tool.enabled,
            autoApprove: typeof message.policies?.[tool.name]?.autoApprove === 'boolean' ? message.policies[tool.name].autoApprove : tool.autoApprove,
          }]));
          await controller.updateDraft(id, { policies }); break;
        }
        case 'upload': {
          if (!Array.isArray(message.files) || message.files.length > 32 || message.files.some((file: Message) => typeof file?.name !== 'string' || typeof file.data !== 'string' || file.path !== undefined)) { throw new Error('Invalid upload.'); }
          const record = message.runId ? controller.runs.find(record => record.id === message.runId) : undefined;
          if (message.runId && (!record?.pendingInput || record.pendingInput.requestId !== message.requestId || controller.workspace.occupiedId !== record.id)) { throw new Error('Input request changed.'); }
          const files = await runtime.uploadFiles(project, record?.scopeId ?? controller.draft(id).scopeId, message.files);
          if (record) { record.files.push(...files); await controller.persist(); changed(); }
          replies.push({ type: 'attachments', entrypointId: id, runId: message.runId, requestId: message.requestId, paramName: message.paramName, files }); break;
        }
        default: throw new Error(`Unsupported workflow action: ${message.type}`);
      }
      return replies;
    },
  };
}
