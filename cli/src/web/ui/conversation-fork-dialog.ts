import { t } from '../localization';
import { renderRequestError } from './request-error';
import './conversation-fork-dialog.css';

interface ForkRequest { requestId: string; projectUri: string; sessionId: string }

/** Keeps creation and opening feedback attached to the initiating request. */
export class ConversationForkDialog {
  private dialog?: HTMLDialogElement;
  private request?: ForkRequest;
  private targetId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private title?: HTMLElement;
  private status?: HTMLElement;
  private progress?: HTMLProgressElement;
  private error?: HTMLElement;
  private closeButton?: HTMLButtonElement;

  start(request: ForkRequest): void {
    this.dispose(); this.request = request;
    const dialog = this.dialog = document.createElement('dialog');
    dialog.className = 'conversation-dialog action-dialog conversation-fork-dialog';
    const title = this.title = document.createElement('h2'); title.id = `fork-${request.requestId}`;
    dialog.setAttribute('aria-labelledby', title.id);
    const header = document.createElement('header'); header.append(title);
    const body = document.createElement('div'); body.className = 'dialog-body';
    const status = this.status = document.createElement('p'); status.id = `${title.id}-status`;
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    dialog.setAttribute('aria-describedby', status.id);
    const progress = this.progress = document.createElement('progress');
    progress.setAttribute('aria-label', t('Creating conversation fork'));
    const error = this.error = document.createElement('div'); error.className = 'fork-error'; error.hidden = true;
    const actions = document.createElement('div'); actions.className = 'prompt-navigation';
    const close = this.closeButton = document.createElement('button'); close.type = 'button'; close.className = 'prompt-button'; close.textContent = t('Close');
    close.onclick = () => this.dispose(); actions.append(close);
    body.append(status, progress, error, actions); dialog.append(header, body);
    dialog.addEventListener('cancel', event => {
      if (dialog.getAttribute('aria-busy') === 'true') event.preventDefault();
      else this.dispose();
    });
    document.body.append(dialog);
    this.busy(t('Creating conversation fork'), t('Copying the history through the selected response and saving the new conversation...'));
    dialog.showModal();
    this.timer = setTimeout(() => this.fail(request, t('Fork creation was not confirmed. Reconnect and check your conversations before trying again.')), 35_000);
  }

  matches(message: Partial<ForkRequest>): boolean {
    return !!this.request && this.targetId === undefined && message.requestId === this.request.requestId
      && message.projectUri === this.request.projectUri && message.sessionId === this.request.sessionId;
  }

  success(message: ForkRequest, targetId: string): void {
    if (!this.matches(message) || !this.dialog) return;
    clearTimeout(this.timer); this.targetId = targetId;
    this.busy(t('Conversation fork created'), t('Opening the new conversation...'));
    this.timer = setTimeout(() => this.failOpening(targetId, t('The conversation was created, but opening it was not confirmed. Open it from conversation history.')), 15_000);
  }

  fail(message: Partial<ForkRequest>, reason: string): boolean {
    if (!this.matches(message)) return false;
    this.failure(t('Could not create conversation fork'), reason); return true;
  }

  failOpening(sessionId: string, reason: string): void {
    if (this.targetId === sessionId) this.failure(t('Conversation created; could not open it'), reason);
  }

  opened(sessionId: string): void { if (this.targetId === sessionId) this.dispose(); }

  private busy(title: string, status: string): void {
    this.dialog!.dataset.status = 'pending'; this.dialog!.setAttribute('aria-busy', 'true');
    this.title!.textContent = title; this.status!.textContent = status;
    this.progress!.hidden = false; this.error!.hidden = true; this.closeButton!.disabled = true;
  }

  private failure(title: string, reason: string): void {
    if (!this.dialog) return;
    clearTimeout(this.timer);
    this.dialog.dataset.status = 'failed'; this.dialog.setAttribute('aria-busy', 'false');
    this.title!.textContent = title; this.status!.textContent = t('Failure reason');
    this.progress!.hidden = true; this.error!.hidden = false; renderRequestError(this.error!, reason);
    this.closeButton!.disabled = false; this.closeButton!.focus();
  }

  dispose(): void {
    clearTimeout(this.timer); this.timer = undefined;
    this.dialog?.remove(); this.dialog = undefined; this.request = undefined; this.targetId = undefined;
  }
}
