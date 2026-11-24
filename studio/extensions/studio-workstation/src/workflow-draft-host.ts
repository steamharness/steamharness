import { parseJsonSummaryDraftStep, parseJsonSummaryOptions, type JsonSummaryOptions } from '../../../vendor/project-templates/project-templates/workflow-draft/json-summary';
import { projectConversationId } from './workflow-webview';
import * as vscode from 'vscode';
import { t } from './localization';
import type { Project } from './workflow-types';
import type { Launcher } from './workflow-cli-types';

export interface WorkflowDraftRequest { requestId: string; sessionId: string; messageId: string; stepId: string; options: JsonSummaryOptions }

export function parseDraftSaveRequest(value: Record<string, unknown>): WorkflowDraftRequest {
  const { requestId, sessionId, messageId, stepId } = value;
  if (!projectConversationId(requestId) || !projectConversationId(sessionId) || typeof messageId !== 'string' || !messageId || messageId.length > 300
    || typeof stepId !== 'string' || !/^[a-f0-9]{24}$/u.test(stepId)) throw new Error('Invalid Workflow draft request.');
  return { requestId, sessionId, messageId, stepId, options: parseJsonSummaryOptions(value.options) };
}

export async function verifyDraftSource(address: string, entryId: string, request: WorkflowDraftRequest, signal: AbortSignal): Promise<boolean> {
  const url = new URL(address);
  const token = new URLSearchParams(url.hash.slice(1)).get('session');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== `/entries/${entryId}/` || !token) return false;
  const response = await fetch(new URL('api/workflow-draft', url), {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: request.sessionId, messageId: request.messageId }),
  });
  if (!response.ok) return false;
  const { steps } = await response.json() as { steps?: unknown[] };
  return Array.isArray(steps) && steps.length <= 24 && steps.some(step => parseJsonSummaryDraftStep(step).id === request.stepId);
}

export function bindDraftSave(options: { webview: vscode.Webview; project: Project; address(): string; active(): boolean;
  create: NonNullable<Launcher['createRunDraft']>; open(directory: string): Promise<void> }): vscode.Disposable {
  const { webview, project, address, active, create, open } = options;
  const lifetime = new AbortController();
  let busy = false;
  const subscription = webview.onDidReceiveMessage(async message => {
    if (message?.type !== 'workflow-save-draft' || message.version !== 1 || !projectConversationId(message.requestId)) return;
    const requestId = message.requestId;
    const reply = (status: 'saved' | 'cancelled' | 'failed', detail?: string) => {
      if (!lifetime.signal.aborted) void webview.postMessage({ type: 'workflow-host', workflowDraftSaved: { version: 1, requestId, status, detail } });
    };
    if (!active()) { reply('failed', t('This run is no longer available for drafting.')); return; }
    if (busy) { reply('failed', t('Another draft is being saved in this view.')); return; }
    busy = true;
    try {
      const request = parseDraftSaveRequest(message), source = address();
      const trusted = (directory: string) => vscode.commands.executeCommand<boolean>('studio.internalSidebarProjectTrust', vscode.Uri.file(directory).toString(), false);
      const verify = async () => {
        if (!active() || address() !== source || !await trusted(project.folderPath) || project.folderBot && !await trusted(project.folderBot.directory)
          || !await verifyDraftSource(source, project.entryId, request, lifetime.signal) || !active() || address() !== source) {
          throw Object.assign(new Error(), { code: 'source-changed' });
        }
      };
      await verify();
      const parents = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        title: t('Choose a parent folder for the Workflow draft'), openLabel: t('Choose Folder') });
      if (parents?.[0]?.scheme !== 'file' || !active()) { reply('cancelled'); return; }
      const name = await vscode.window.showInputBox({ title: t('Name the Workflow draft'), prompt: t('Studio will create a new local Workflow folder. It will not run it.'),
        value: t('JSON Summary'), ignoreFocusOut: true });
      if (name === undefined || !active()) { reply('cancelled'); return; }
      await verify();
      const created = await create({ name, parentDirectory: parents[0].fsPath, options: request.options }, lifetime.signal);
      reply('saved', created.directory);
      const label = t('Open Folder');
      void vscode.window.showInformationMessage(t('Workflow draft saved to {0}.', created.directory), label).then(async action => {
        if (action === label) await open(created.directory);
      }, () => undefined).then(undefined, () => void vscode.window.showErrorMessage(t('Could not open the Workflow draft folder.')));
    } catch (error) {
      const code = (error as { code?: string }).code;
      reply('failed', code === 'source-changed' ? t('This run is no longer available for drafting.') : code === 'directory-exists' ? t('The project folder already exists.')
        : code === 'invalid-name' ? t('Choose a name that is valid as a folder on Windows, macOS and Linux.')
          : code === 'invalid-parent' ? t('Choose an existing parent folder.') : t('Could not save the Workflow draft.'));
    } finally { busy = false; }
  });
  return { dispose: () => { lifetime.abort(); subscription.dispose(); } };
}
