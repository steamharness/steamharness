import { installProjectKeyboardBridge, isProjectKeyboardEvent } from '@steamharness/kanban-project';

export function acquireHostKeyboard() {
  let enabled = false;
  let dispose: (() => void) | undefined;
  const forward = (event: unknown) => {
    if (enabled && window.parent !== window && isProjectKeyboardEvent(event)) {
      window.parent.postMessage({ type: 'workflow-keyboard', version: 1, event }, '*');
    }
  };
  addEventListener('pagehide', () => { dispose?.(); dispose = undefined; }, { once: true });
  return { forward, get enabled() { return enabled; }, enable: (version: unknown) => {
    const next = version === 1;
    if (enabled !== next) {
      enabled = next; dispose?.(); dispose = enabled ? installProjectKeyboardBridge(window, () => enabled, forward) : undefined;
      dispatchEvent(new Event('workflow-keyboard-host-change'));
    }
  } };
}
