import { installContextMenu } from './context-menu';

declare function acquireVsCodeApi(): { postMessage(message: object): void };
const host = acquireVsCodeApi();
const button = document.getElementById('assistant-action');
if (button) { button.onclick = () => host.postMessage({ type: button.dataset.action }); }
installContextMenu(host, () => button ? [{ id: button.dataset.action === 'assistant-open-folder' ? 'open' : 'retry', run: () => button.click() }] : []);
