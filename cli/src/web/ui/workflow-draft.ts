import { t } from '../localization';
import type { WorkflowDraftPreview } from '../workflow-draft';
import { requestRunDraft } from './connection';
import { iconButton } from './ui';
import { parseJsonSummaryOptions } from '../../project-templates/workflow-draft/json-summary';
import './workflow-draft.css';

const text = <K extends keyof HTMLElementTagNameMap>(tag: K, value: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.textContent = value; return node;
};

export function openRunDraft(sessionId: string, messageId: string): void {
  const dialog = document.createElement('dialog'); dialog.className = 'conversation-dialog workflow-draft-dialog';
  const header = document.createElement('header'), title = text('h2', t('Save as Workflow draft'));
  title.id = `workflow-draft-${crypto.randomUUID()}`; dialog.setAttribute('aria-labelledby', title.id);
  const dismiss = iconButton('close', t('Close'), () => dialog.close());
  header.append(title, dismiss);
  const body = document.createElement('div'); body.className = 'dialog-body';
  const status = text('p', t('Checking the run…')); status.setAttribute('role', 'status'); body.append(status);
  dialog.append(header, body); document.body.append(dialog);
  const request = new AbortController();
  let saving: string | undefined;
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { request.abort(); dialog.remove(); }, { once: true });
  dialog.showModal();
  void (async () => {
    const response = await requestRunDraft(sessionId, messageId, request.signal);
    if (!response.ok) { status.textContent = t('This run is no longer available for drafting.'); return; }
    const data = await response.json() as WorkflowDraftPreview;
    if (request.signal.aborted) return;
    if (data.steps.length) {
      const form = document.createElement('form');
      const select = document.createElement('select');
      data.steps.forEach((step, index) => {
        const option = text('option', step.groupBy ? t('JSON summary {0} · {1}', index + 1, step.groupBy) : t('JSON summary {0}', index + 1));
        option.value = step.id; select.append(option);
      });
      const ordered = document.createElement('ol');
      for (const label of ['Read the selected JSON input', 'Count or group the rows', 'Write the JSON report']) ordered.append(text('li', t(label)));
      const field = document.createElement('input'); field.maxLength = 80;
      const file = document.createElement('input'); file.maxLength = 69; file.required = true;
      const label = (caption: string, input: HTMLElement) => { const row = text('label', caption); row.append(input); return row; };
      const selectDefaults = () => {
        const step = data.steps.find(item => item.id === select.value);
        if (step) { field.value = step.groupBy ?? ''; file.value = step.outputName; }
      };
      select.onchange = selectDefaults; selectDefaults();
      const save = text('button', t('Choose where to save')); save.type = 'submit'; save.className = 'prompt-button';
      form.append(label(t('Operation'), select), ordered, label(t('Group by (optional)'), field), label(t('Report file name'), file), save);
      window.addEventListener('message', event => {
        const result = event.data?.workflowDraftSaved;
        if (event.source !== window.parent || event.data?.type !== 'workflow-host' || result?.version !== 1 || !saving || result.requestId !== saving) return;
        saving = undefined; save.disabled = dismiss.disabled = false;
        if (result.status === 'saved') { dialog.close(); return; }
        status.textContent = result.status === 'cancelled' ? t('Save cancelled. No files were created.') : result.detail || t('Could not save the Workflow draft.');
      }, { signal: request.signal });
      form.onsubmit = event => {
        event.preventDefault();
        if (saving) return;
        status.hidden = false;
        let options;
        try { options = parseJsonSummaryOptions({ groupBy: field.value.trim() || undefined, outputName: file.value.trim() }); }
        catch (error) { status.textContent = t((error as Error).message); return; }
        saving = crypto.randomUUID(); save.disabled = dismiss.disabled = true;
        status.textContent = t('Waiting for Studio to save the draft…');
        window.parent.postMessage({ type: 'workflow-save-draft', version: 1, requestId: saving, sessionId, messageId, stepId: select.value, options }, '*');
      };
      status.hidden = true; body.append(form);
    } else status.textContent = t('No supported steps were recorded for this run.');
    const excluded = document.createElement('details');
    excluded.append(text('summary', t('Excluded from the draft')));
    const list = document.createElement('ul');
    for (const item of data.excluded) {
      const tool = item.tool === 'model-response' ? t('Model response') : item.tool === 'other-output' ? t('Other output') : item.tool;
      list.append(text('li', `${tool} (${item.count})`));
    }
    if (list.childElementCount) { excluded.append(list); body.append(excluded); }
  })().catch(() => { if (!request.signal.aborted) status.textContent = t('The run could not be checked.'); });
}
