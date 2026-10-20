import { t } from '../localization';
import { sessionRunning, type ConversationSession } from '../workflow-types';
import { iconHtml, updateIcon } from './ui';

interface HistoryStatus { status: string; icon: string; label: string }

export const runStatusLabels: Record<string, string> = {
  running: t('Running'), waiting_for_input: t('Waiting for input'), success: t('Completed'), failed: t('Failed'),
  aborted: t('Stopped'), timed_out: t('Timed out'), interrupted: t('Interrupted'),
};
const runIcons: Record<string, string> = {
  running: 'loading', waiting_for_input: 'question', success: 'pass', failed: 'error',
  aborted: 'debug-stop', timed_out: 'watch', interrupted: 'debug-disconnect',
};

export function workflowHistoryStatus(status: string): HistoryStatus {
  return { status, icon: runIcons[status] ?? 'info', label: runStatusLabels[status] ?? status };
}

export function conversationHistoryStatus(session: ConversationSession): HistoryStatus | undefined {
  if (session.messages.some(message => message.pendingInput)) { return { status: 'waiting_for_input', icon: 'question', label: t('Pending approval') }; }
  if (sessionRunning(session)) { return workflowHistoryStatus('running'); }
  const context = session.agent?.contexts.find(context => context.conversationId === (session.agentConversationId ?? session.agent?.conversationId));
  const background = context?.backgroundCount ?? session.agent?.backgroundCount ?? 0;
  if (background) { return { status: 'background', icon: 'server-process', label: t('Background tasks: {0}', background) }; }
  if (session.messages.at(-1)?.status === 'failed') { return workflowHistoryStatus('failed'); }
  return undefined;
}

export function updateHistoryStatus(root: HTMLElement, status?: HistoryStatus): void {
  root.hidden = !status;
  if (!status) { return; }
  root.dataset.status = status.status;
  root.title = root.ariaLabel = status.label;
  root.setAttribute('role', 'img');
  updateIcon(root, status.icon);
}

export function updateRunningCount(root: HTMLElement, count: number, label: string): void {
  root.hidden = count === 0;
  root.title = root.ariaLabel = label;
  root.setAttribute('role', 'img');
  if (!root.childNodes.length) {
    root.innerHTML = iconHtml('loading');
    root.append(document.createElement('span'));
  }
  const value = root.lastElementChild!;
  if (value.textContent !== String(count)) { value.textContent = String(count); }
}

export function updateConversationRunningCount(root: HTMLElement, sessions: ConversationSession[]): void {
  const count = sessions.filter(sessionRunning).length;
  updateRunningCount(root, count, t('Running conversations: {0}', count));
}
