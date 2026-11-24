import type { ScheduleFireStatus, ScheduleInput, SchedulePreset } from '../../../../shared/workflow-schedules/index';

export interface ScheduleTarget { directory: string; projectId: string; entryId: string; version: string }
export interface LocalSchedule extends ScheduleInput { id: string; target: ScheduleTarget; nextFireAt?: number }
export interface LocalFire { id: string; scheduleId: string; scheduledFor: number; manual: boolean; status: ScheduleFireStatus; reason?: string; runId?: string }
export type SchedulePanelMetadata = {
  labels: Record<('title' | 'newPlan' | 'noPlans' | 'details' | 'report' | 'name' | 'operation' | 'timezone' | 'parameters' |
    'rule' | 'cron' | 'cronExpression' | 'interval' | 'weekdays' | 'windows' | 'intervalMinutes' | 'presets' | 'selectPreset' |
    'windowStart' | 'windowEnd' | 'addWindow' | 'removeWindow' | 'preview' | 'next' | 'save' | 'pause' | 'enable' | 'run' |
    'open' | 'remove' | 'more' | 'latest' | 'enabled' | 'disabled' | 'saved' | 'clock' | 'manual' | 'emptyHistory'), string> & {
    days: string[]; reasons: Record<string, string>; states: Record<ScheduleFireStatus, string>;
  };
  project: string;
  target: ScheduleTarget;
  operations: { id: string; title?: string }[];
  presets: SchedulePreset[];
};
