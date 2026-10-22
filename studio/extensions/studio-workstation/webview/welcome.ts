import { installContextMenu } from './context-menu';

declare function acquireVsCodeApi(): { postMessage(message: object): void };
const host = acquireVsCodeApi();
const button = document.querySelector<HTMLButtonElement>('#assistant-action');
if (button) {
  button.onclick = () => {
    if (button.disabled) { return; }
    if (button.dataset.action === 'assistant-retry') {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = button.dataset.busyLabel ?? button.textContent;
      const status = document.getElementById('assistant-status');
      if (status) {
        status.textContent = button.dataset.busyStatus ?? status.textContent;
        status.closest('[role="status"]')?.setAttribute('aria-busy', 'true');
      }
    }
    host.postMessage({ type: button.dataset.action });
  };
}
installContextMenu(host, () => button && !button.disabled ? [{ id: button.dataset.action === 'assistant-open-folder' ? 'open' : 'retry', run: () => button.click() }] : []);
