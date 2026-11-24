import * as core from 'steamharness';
import type { ScheduleParamDefinition, ScheduleSourceMetadata } from 'steamharness';
import type { Controller } from './workflow-controller';
import type { WorkflowHistory } from './workflow-history';
import { projectFormValue, validateProjectValues, type Project } from './workflow-types';
import type { RunRecord } from './workflow-workspace';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const reply = (status: string, reason?: string) => ({ status, reason });
const state = (run: RunRecord) => (run.status === 'running' ? reply('running') : run.pendingInput ? reply('waiting_for_input')
  : run.status === 'success' ? reply('success') : reply('failed', run.status === 'failed' ? 'run-failed' : run.status));

export function workflowScheduleHandler(project: Project, controller: Controller, history: WorkflowHistory, authorized: () => boolean) {
  let starting = false;
  return async (request: Record<string, unknown>) => {
    if (request.projectId !== project.id || request.directory !== project.folderPath) return reply('skipped_invalid_target', 'target-changed');
    if (request.action === 'status' || request.action === 'view') {
      if (!uuid(request.runId)) return reply('not_found');
      const run = controller.runs.find(run => run.id === request.runId && run.schedule?.fireId === run.id && run.schedule.scheduleId === request.scheduleId);
      if (!run || !history.ownsHistory) return reply('not_found');
      if (request.action === 'view') return reply(authorized() && request.version === project.manifest?.version ? 'view' : 'not_found');
      if (run.status !== 'running') await controller.idle();
      return state(run);
    }
    if (request.version !== project.manifest?.version || project.distribution === 'release') return reply('skipped_invalid_target', 'target-changed');
    if (!authorized()) return reply('skipped_authorization', 'authorization-changed');
    if (typeof core.validateProjectScheduleParamValues !== 'function') return reply('skipped_invalid_target', 'upgrade-runtime');
    const operation = project.entrypoints.find(entry => entry.id === request.entrypointId);
    if (!operation) return reply('skipped_invalid_target', 'operation-changed');
    const raw = request.paramValues;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reply('skipped_invalid_target', 'invalid-parameters');
    let params;
    try {
      const values = raw as Record<string, unknown>;
      // No machine paths, attachments, platform credentials or stored approval policies cross this channel.
      if (operation.fields.some(field => (field.type === 'file' || field.userSetting) && (Object.hasOwn(values, field.name) || field.type === 'file' && !!field.defaultValue))) {
        throw new Error('Unsupported schedule parameter.');
      }
      const definitions = operation.fields.map(field => {
        const { type } = field;
        if (type !== 'number' && type !== 'string' && type !== 'boolean' && type !== 'file' && type !== 'positional') throw new Error('Unsupported schedule parameter.');
        return { ...field, type } satisfies ScheduleParamDefinition;
      });
      core.validateProjectScheduleParamValues(values, definitions);
      params = Object.fromEntries(operation.fields.map(field => [field.name, projectFormValue(field, values[field.name] ?? field.defaultValue)]));
      validateProjectValues(operation.fields, params);
    } catch { return reply('skipped_invalid_target', 'invalid-parameters'); }
    if (request.action === 'validate') return reply('valid');
    const input = request.schedule as Partial<ScheduleSourceMetadata> | undefined;
    if (request.action !== 'start' || input?.source !== 'schedule' || !uuid(input.scheduleId) || !uuid(input.fireId)
      || typeof input.scheduleName !== 'string' || !input.scheduleName || input.scheduleName.length > 100
      || typeof input.scheduledFor !== 'string' || !Number.isFinite(Date.parse(input.scheduledFor))
      || (input.triggerKind !== 'cron' && input.triggerKind !== 'window-interval')) return reply('skipped_invalid_target', 'invalid-receipt');
    const deadline = request.deadline;
    const onTime = () => typeof deadline === 'number' && Date.now() <= deadline && deadline - Date.now() <= 60_000;
    if (!onTime()) return reply('skipped_missed', 'launch-deadline');
    if (starting) return reply('skipped_overlap', 'entry-active');
    starting = true;
    try {
      const saved = await history.prepareScheduledWrite();
      if (saved) controller.replace(saved);
      const previous = controller.runs.find(run => run.id === input.fireId);
      if (previous) return previous.schedule?.scheduleId === input.scheduleId ? state(previous) : reply('skipped_invalid_target', 'invalid-receipt');
      if (!onTime()) return reply('skipped_missed', 'launch-deadline');
      if (!authorized()) return reply('skipped_authorization', 'authorization-changed');
      if (controller.running) return reply('skipped_overlap', 'entry-active');
      const schedule: ScheduleSourceMetadata = { source: 'schedule', fireId: input.fireId, scheduleId: input.scheduleId, scheduleName: input.scheduleName,
        scheduledFor: input.scheduledFor, triggerKind: input.triggerKind };
      const run = await controller.start({ entrypointId: operation.id, title: `${operation.title ?? operation.id} · ${schedule.scheduleName}`, params, schedule });
      if (run.status !== 'running') await controller.idle();
      return state(run);
    } catch (error) {
      if ((error as { code?: string }).code === 'RUNTIME_STORAGE_OWNER_CONFLICT') return reply('owner_conflict');
      return reply('failed', 'start-failed');
    } finally { starting = false; }
  };
}
