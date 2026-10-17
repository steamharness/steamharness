import { t } from '../localization';
import { iconButton } from './ui';

export function requestAction(options: { title: string; confirm: string; label?: string; value?: string; danger?: boolean; multiline?: boolean; required?: boolean }): Promise<string | undefined> {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'conversation-dialog action-dialog';
    const title = document.createElement('h2'); title.id = `action-${crypto.randomUUID()}`; title.textContent = options.title;
    dialog.setAttribute('aria-labelledby', title.id);
    const header = document.createElement('header'); header.append(title, iconButton('close', t("Close"), () => dialog.close()));
    const form = document.createElement('form'); form.className = 'dialog-body';
    let input: HTMLInputElement | HTMLTextAreaElement | undefined, result: string | undefined;
    if (options.label) {
      const label = document.createElement('label'); label.textContent = options.label;
      input = options.multiline ? document.createElement('textarea') : document.createElement('input');
      if (input instanceof HTMLInputElement) input.type = 'text';
      input.required = options.required !== false; input.autofocus = true; input.value = options.value ?? '';
      label.append(input); form.append(label);
    }
    const actions = document.createElement('div'); actions.className = 'prompt-navigation';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'prompt-button'; cancel.textContent = t("Cancel"); cancel.onclick = () => dialog.close();
    const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.className = 'prompt-button'; confirm.textContent = options.confirm;
    if (options.danger) { confirm.classList.add('danger'); }
    actions.append(cancel, confirm); form.append(actions); dialog.append(header, form);
    form.onsubmit = event => {
      event.preventDefault();
      if (input?.required && !input.value.trim()) { input.focus(); return; }
      result = input?.value.trim() ?? ''; dialog.close();
    };
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
    document.body.append(dialog); dialog.showModal();
  });
}
