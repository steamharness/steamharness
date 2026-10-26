import type { ProjectServerCreateContext } from '../project-server-create';
import { t } from '../localization';
import { iconButton } from './ui';
import './project-server-guidance.css';

type Message = Record<string, any>;

export class ProjectServerCreateDialog {
  private dialog?: HTMLDialogElement;
  private identity?: string;
  private generation = 0;
  constructor(private readonly request: (message: Message) => Promise<Message[]>) {}
  update(message: Message): void {
    if (message.type !== 'state') return;
    const identity = JSON.stringify([message.serverInstanceId, message.account?.serverUrl, message.account?.user?.userId, message.authenticationRevision]);
    if (this.identity !== undefined && (this.identity !== identity || message.account?.status !== 'authenticated')) this.dialog?.close();
    this.identity = identity;
  }
  close(): void { this.dialog?.close(); this.generation++; }
  async open(): Promise<void> {
    if (this.dialog) { this.dialog.focus(); return; }
    const generation = ++this.generation;
    const dialog = this.dialog = document.createElement('dialog'); dialog.className = 'conversation-dialog project-server-create';
    const title = document.createElement('h2'); title.id = `create-project-${crypto.randomUUID()}`; title.textContent = t('New project on Server');
    dialog.setAttribute('aria-labelledby', title.id);
    const close = iconButton('close', t('Close'), () => dialog.close());
    const header = document.createElement('header'); header.append(title, close);
    const form = document.createElement('form'); form.className = 'dialog-body';
    const description = document.createElement('p'); description.id = `${title.id}-description`;
    description.textContent = t('Create a private Server project with the same project ID for Server data access. Source upload is optional and can be done later.');
    dialog.setAttribute('aria-describedby', description.id);
    const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = t('Loading project groups...');
    const error = document.createElement('p'); error.className = 'project-server-create-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    const actions = document.createElement('div'); actions.className = 'prompt-navigation';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'prompt-button'; cancel.textContent = t('Cancel'); cancel.onclick = () => dialog.close();
    const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.className = 'prompt-button'; confirm.textContent = t('Create project'); confirm.disabled = true;
    actions.append(cancel, confirm); form.append(description, status, error, actions); dialog.append(header, form);
    let context: ProjectServerCreateContext | undefined, busy = false;
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (this.dialog === dialog) this.dialog = undefined;
      this.generation++; dialog.remove();
      if (context) void this.request({ type: 'project-server-create-cancel', token: context.token }).catch(() => undefined);
    }, { once: true });
    document.body.append(dialog); dialog.showModal();
    try {
      const replies = await this.request({ type: 'project-server-create-prepare' });
      context = replies.find(reply => reply.type === 'project-server-create-context')?.context;
      if (this.generation !== generation || this.dialog !== dialog) {
        if (context) void this.request({ type: 'project-server-create-cancel', token: context.token }).catch(() => undefined);
        return;
      }
      if (!context) throw new Error(t('Could not load project groups. Try again.'));
      const details = document.createElement('dl');
      for (const [label, value] of [[t('Server'), context.serverUrl], [t('Project ID'), context.projectId], [t('Project type'), context.projectType]]) {
        const term = document.createElement('dt'), definition = document.createElement('dd'); term.textContent = label; definition.textContent = value; details.append(term, definition);
      }
      const nameLabel = document.createElement('label'); nameLabel.textContent = t('Project name');
      const name = document.createElement('input'); name.type = 'text'; name.required = true; name.maxLength = 200; name.value = context.name; nameLabel.append(name);
      const groupLabel = document.createElement('label'); groupLabel.textContent = t('Project group');
      const group = document.createElement('select'); group.append(new Option(t('Personal project'), ''), ...context.groups.map(item => new Option(item.name, item.id))); groupLabel.append(group);
      status.hidden = true; form.insertBefore(details, error); form.insertBefore(nameLabel, error); form.insertBefore(groupLabel, error); confirm.disabled = false; name.focus();
      form.onsubmit = async event => {
        event.preventDefault(); if (busy || !name.value.trim()) { if (!busy) name.focus(); return; }
        busy = true; confirm.disabled = true; cancel.disabled = true; close.disabled = true; name.disabled = true; group.disabled = true;
        status.hidden = false; status.textContent = t('Creating project...'); error.hidden = true;
        try {
          const replies = await this.request({ type: 'project-server-create-confirm', token: context!.token, confirmed: true, name: name.value.trim(), ...(group.value ? { groupId: group.value } : {}) });
          if (!replies.some(reply => reply.type === 'project-server-created')) throw new Error(t('Could not create the Server project. Check the Server and project group, then try again.'));
          dialog.close();
        } catch (failure) {
          if (this.dialog === dialog) { error.textContent = (failure as Error).message; error.hidden = false; }
        } finally {
          busy = false; confirm.disabled = false; cancel.disabled = false; close.disabled = false; name.disabled = false; group.disabled = false; status.hidden = true;
        }
      };
    } catch (failure) {
      if (this.dialog === dialog) { status.hidden = true; error.textContent = (failure as Error).message; error.hidden = false; }
    }
  }
}
