import * as vscode from 'vscode';
import { parseProjectScheduleInput, parseProjectSchedulePresets, previewProjectSchedule } from '../../../../shared/workflow-schedules/index';
import { t } from './localization';
import { scheduleTargetKey, type LocalSchedule, type ScheduleTarget } from './workflow-schedule-store';
import type { WorkflowScheduleRuntime } from './workflow-schedule-runtime';
import type { Project } from './workflow-types';
import type { SchedulePanelMetadata } from './workflow-schedule-contract';

const labels = () => ({
  title: t('Workflow schedules'), newPlan: t('New schedule'), noPlans: t('No schedules'), details: t('Schedule'), report: t('Trigger history'),
  name: t('Name'), operation: t('Workflow operation'), timezone: t('Time zone'), parameters: t('Static parameters (JSON)'),
  rule: t('Rule'), cron: t('Cron'), cronExpression: t('Five-field Cron expression'), interval: t('Time windows'),
  weekdays: t('Days'), days: [t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday'), t('Sunday')],
  windows: t('Time windows'), intervalMinutes: t('Every N minutes'), presets: t('Suggested schedules'), selectPreset: t('Choose a preset'),
  windowStart: t('Start time'), windowEnd: t('End time'), addWindow: t('Add time window'), removeWindow: t('Remove time window'),
  preview: t('Preview next five'), next: t('Next trigger'), save: t('Save schedule'), pause: t('Pause schedule'), enable: t('Enable schedule'),
  run: t('Run now'), open: t('Open original run'), remove: t('Delete schedule'), more: t('Older triggers'), latest: t('Latest triggers'),
  enabled: t('Enabled'), disabled: t('Paused'), saved: t('Schedule saved.'), clock: t('Scheduled'), manual: t('Manual'), emptyHistory: t('No triggers recorded'),
  reasons: {
    'studio-offline': t('Studio was closed or asleep.'), 'paused-before-launch': t('Paused before the run started.'),
    'previous-active': t('Another trigger of this schedule is active or waiting for input.'), 'entry-active': t('The Workflow entry is busy.'),
    'launch-deadline': t('The Workflow did not start before the launch deadline.'), 'authorization-changed': t('The project is not trusted or its authorization changed.'),
    'target-changed': t('The project folder, entry, or source version changed.'), 'operation-changed': t('The Workflow operation is no longer available.'),
    'invalid-parameters': t('Check the static parameters. File inputs are not supported for schedules.'),
    'invalid-receipt': t('The trigger identity is invalid.'), 'upgrade-runtime': t('Update this project’s SteamHarness CLI to use Workflow schedules.'),
    'run-not-started': t('No run was recorded for this trigger. It was not retried.'), 'start-failed': t('The Workflow could not start.'),
    'run-failed': t('The Workflow failed. Open the original run for details.'), interrupted: t('The run was interrupted.'),
    aborted: t('The run was stopped.'), timed_out: t('The run timed out.'),
  },
  states: {
    pending: t('Queued'), running: t('Running'), success: t('Completed'), failed: t('Failed'), waiting_for_input: t('Waiting for input'),
    skipped_overlap: t('Skipped · overlap'), skipped_missed: t('Missed'), skipped_authorization: t('Skipped · authorization'), skipped_invalid_target: t('Skipped · target'),
  },
});

export function openProjectSchedules(context: vscode.ExtensionContext, runtime: WorkflowScheduleRuntime, project: Project, target: ScheduleTarget,
  openRun: (id: string, liveUrl?: string) => Promise<void>): void {
  const root = vscode.Uri.joinPath(context.extensionUri, 'dist');
  const panel = vscode.window.createWebviewPanel('studio.workflowSchedules', t('Workflow schedules'), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [root] });
  const locale = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  const source = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'schedules-ui.js'));
  const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'schedules.css'));
  const codicons = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'codicons', 'codicon.css'));
  panel.webview.html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource}; font-src ${panel.webview.cspSource}">
    <link rel="stylesheet" href="${css}"><link rel="stylesheet" href="${codicons}"></head><body><main id="schedules"></main><script src="${source}"></script></body></html>`;
  const translations = labels(), lifetime = new AbortController();
  const presets = parseProjectSchedulePresets(project.entries.find(entry => entry.entryId === target.entryId)?.schedulePresets, 'workflow');
  const metadata: SchedulePanelMetadata = { labels: translations, project: project.name, target, operations: project.entrypoints.map(({ id, title }) => ({ id, title })), presets };
  let selected: string | undefined, before: number | undefined, ready = false, busy = false, signature = '';
  const publish = (force = false) => {
    if (!ready || lifetime.signal.aborted || !panel.visible && !force) return;
    const plans = runtime.store.list(target).map(plan => ({ ...plan, active: runtime.store.active(plan.id) }));
    const history = selected ? runtime.store.history(selected, before) : [];
    const snapshot = { plans, selected, history, older: before !== undefined };
    const key = JSON.stringify(snapshot);
    if (force || signature !== key) { signature = key; void panel.webview.postMessage({ type: 'state', ...snapshot }); }
  };
  const errorMessage = (error: unknown) => {
    const code = error instanceof Error ? error.message : '';
    if (Object.hasOwn(translations.reasons, code)) return translations.reasons[code as keyof typeof translations.reasons];
    if (code === 'active') return t('Wait for the active run or its input before editing or deleting this schedule.');
    if (code === 'plan-changed') return t('The schedule changed in another window. Review it and try again.');
    if (code === 'plan-limit') return t('The local schedule limit has been reached.');
    return t('Check the schedule rule, time zone and parameters.');
  };
  const get = (id: unknown): LocalSchedule | undefined => {
    const value = typeof id === 'string' ? runtime.store.get(id) : undefined;
    return value && scheduleTargetKey(value.target) === scheduleTargetKey(target) ? value : undefined;
  };
  const receive = panel.webview.onDidReceiveMessage(async message => {
    if (!message || lifetime.signal.aborted) return;
    if (message.type === 'ready') { ready = true; void panel.webview.postMessage({ type: 'init', ...metadata }); publish(true); return; }
    if (!ready || busy) return;
    busy = true;
    let result: { preview?: string[]; saved?: true; error?: string } = {};
    try {
      const plan = get(message.id);
      if (message.type === 'select') { selected = plan?.id; before = undefined; }
      else if (message.type === 'history' && plan) {
        const rows = runtime.store.history(plan.id, before);
        before = message.older === true ? rows.at(-1)?.cursor : undefined;
      } else if (message.type === 'preview' || message.type === 'save') {
        if (message.type === 'save' && message.id && (!plan || runtime.store.active(plan.id))) throw new Error('active');
        const input = parseProjectScheduleInput({ ...message.input, enabled: false, resolvedTarget: 'dev' });
        if (JSON.stringify(input).length > 24_000 || !project.entrypoints.some(operation => operation.id === input.entrypointId)) throw new Error('invalid-parameters');
        const preview = previewProjectSchedule(input);
        result = { preview: preview.nextRuns };
        if (message.type === 'save') {
          await runtime.validate(target, input, lifetime.signal);
          lifetime.signal.throwIfAborted();
          selected = runtime.store.save(target, input, Date.now(), plan?.id, plan).id;
          before = undefined; result.saved = true;
        }
      } else if (plan && (message.type === 'enable' || message.type === 'run')) {
        const label = message.type === 'enable' ? translations.enable : translations.run;
        const when = previewProjectSchedule(plan).nextRuns[0];
        const detail = `${plan.target.directory}\n${plan.target.entryId} / ${plan.entrypointId} · ${plan.target.version}\n${plan.timezone}${when && message.type === 'enable' ? ` · ${when}` : ''}`;
        if (await vscode.window.showWarningMessage(label, { modal: true, detail }, label) === label && !lifetime.signal.aborted) {
          if (message.type === 'run' && runtime.store.active(plan.id)) runtime.store.manual(plan.id, Date.now(), plan);
          else {
            await runtime.validate(plan.target, plan, lifetime.signal);
            lifetime.signal.throwIfAborted();
            if (message.type === 'enable') runtime.store.setEnabled(plan.id, true, Date.now(), plan);
            else runtime.store.manual(plan.id, Date.now(), plan);
          }
          runtime.scheduler.tick();
        }
      } else if (plan && message.type === 'pause') runtime.store.setEnabled(plan.id, false, Date.now(), plan);
      else if (plan && message.type === 'delete') {
        if (await vscode.window.showWarningMessage(t('Delete schedule “{0}” and its trigger receipts?', plan.name), { modal: true }, translations.remove) === translations.remove && !lifetime.signal.aborted) {
          runtime.store.remove(plan.id, plan); selected = undefined; before = undefined;
        }
      } else if (plan && message.type === 'open') {
        const fire = runtime.store.history(plan.id, before).find(row => row.id === message.fireId);
        if (fire?.runId && fire.status !== 'running') await openRun(fire.runId, await runtime.existingRunView(plan, fire, lifetime.signal));
      }
    } catch (error) { result = { error: errorMessage(error) }; }
    finally {
      busy = false;
      if (!lifetime.signal.aborted) { publish(true); void panel.webview.postMessage({ type: 'result', ...result }); }
    }
  });
  const timer = setInterval(() => { try { publish(); } catch { /* Keep the current view on a transient storage error. */ } }, 1_500);
  panel.onDidChangeViewState(() => { if (panel.visible) { try { publish(true); } catch { /* Retry on the next poll. */ } } });
  panel.onDidDispose(() => { lifetime.abort(); clearInterval(timer); receive.dispose(); });
}
