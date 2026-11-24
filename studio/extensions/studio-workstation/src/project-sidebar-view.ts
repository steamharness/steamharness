import * as vscode from 'vscode';
import { t } from './localization';
import { hostedSidebarHtml, sidebarStatusDocument } from './project-sidebar-html';
import type { HostedSidebarPreview, HostedSidebarProject, HostedSidebarState, OpenHostedSidebar } from './project-sidebar-types';

export const sidebarStatusHtml = (message: string, label?: string) => sidebarStatusDocument(vscode.env.language, message, label);

export function bindHostedSidebar(view: vscode.WebviewView, project: HostedSidebarProject, open: OpenHostedSidebar, output: vscode.OutputChannel): void {
  let state: HostedSidebarState | undefined, attempt: AbortController | undefined, active: HostedSidebarPreview | undefined;
  let disposed = false, failures = 0, statusHtml = '';
  let retry: ReturnType<typeof setTimeout> | undefined;
  const clearRetry = () => { clearTimeout(retry); retry = undefined; };
  const close = () => {
    clearRetry(); failures = 0; statusHtml = '';
    attempt?.abort(); attempt = undefined;
    const preview = active; active = undefined;
    if (preview) void preview.close();
  };
  const status = (message: string, label?: string) => {
    const key = JSON.stringify([message, label]);
    if (statusHtml === key) return;
    statusHtml = key;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = sidebarStatusHtml(message, label);
  };
  const render = () => {
    if (disposed) return;
    const next = project.getState();
    if (!state || ('binding' in next ? !('binding' in state) || next.binding !== state.binding : 'binding' in state)) close();
    state = next;
    if (!('binding' in state)) { status(state.message, state.action?.label); return; }
    if (active || attempt || retry || !view.visible) return;
    status(t('Opening project entry...'));
    const controller = attempt = new AbortController();
    void open(project, state.binding, controller.signal).then(preview => {
      if (disposed || controller.signal.aborted || attempt !== controller) { void preview.close(); return; }
      try {
        const port = Number(new URL(preview.url).port);
        view.webview.options = { enableScripts: true, localResourceRoots: [], ...(vscode.env.uiKind === vscode.UIKind.Web ? {} : { portMapping: [{ webviewPort: port, extensionHostPort: port }] }) };
        view.webview.html = hostedSidebarHtml(vscode.env.language, project.title, preview);
        active = preview; failures = 0; statusHtml = '';
      } catch (error) { void preview.close(); throw error; }
    }).catch(error => {
      if (disposed || controller.signal.aborted || attempt !== controller) return;
      if (!failures) output.appendLine(`[sidebar] ${project.title}: ${String(error)}`);
      status(t('The built-in project files are unavailable.'), t('Retry'));
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(failures++, 4));
      if (view.visible) retry = setTimeout(() => { retry = undefined; render(); }, delay);
    }).finally(() => { if (attempt === controller) attempt = undefined; });
  };
  const subscriptions = [project.onDidChange(render), view.onDidChangeVisibility(() => { if (view.visible) render(); else clearRetry(); }),
    view.webview.onDidReceiveMessage(value => {
      if (disposed || !view.visible || !state) return;
      if (!('binding' in state)) {
        if (value?.type === 'studio-sidebar-action') return state.action?.run();
      } else if (value?.type === 'studio-sidebar-action' && !active) { clearRetry(); render(); }
      else if (value?.type === 'studio-sidebar-account' && active && state.binding.accountUrl) return vscode.env.openExternal(vscode.Uri.parse(state.binding.accountUrl));
    })];
  view.onDidDispose(() => { disposed = true; close(); for (const listener of subscriptions) listener.dispose(); });
  render();
}
