import * as vscode from 'vscode';
import { t } from './localization';

export interface ResourceCardTarget {
  id: string; kind: 'kv' | 'knowledge' | 'project' | 'browser' | 'file' | 'kanban'; title: string;
  target: Record<string, string>; preview?: boolean;
}
export interface ResourceCardResult { id: string; url: string; action: 'open' | 'window' | 'project'; card: ResourceCardTarget; project?: import('./workflow-types').Project }

export function bindProjectResourceCards(webview: vscode.Webview, sessionUrl: string | (() => string), open: (result: ResourceCardResult) => Promise<void>) {
  const controller = new AbortController();
  let pending = 0;
  return {
    receive(message: Record<string, any> | undefined): boolean {
      if (message?.type !== 'workflow-resource' || message.version !== 1) { return false; }
      const request = message.request;
      if (controller.signal.aborted || !request || request.type !== 'resource' || !['open', 'window', 'project'].includes(request.action ?? 'open')
        || typeof request.cardId !== 'string' || request.cardId.length > 32_768 || pending >= 8) { return true; }
      const action = { type: 'resource', action: request.action ?? 'open', cardId: request.cardId, messageId: request.messageId,
        runId: request.runId, sessionId: request.sessionId, projectUri: request.projectUri };
      pending++;
      void (async () => {
        const url = new URL(typeof sessionUrl === 'function' ? sessionUrl() : sessionUrl), token = new URLSearchParams(url.hash.slice(1)).get('session');
        const response = await fetch(new URL('/api/message', url), { method: 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(action),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
        const payload = await response.json() as { message?: string; messages?: ({ type: string } & ResourceCardResult)[] };
        if (!response.ok) { throw new Error(payload.message || t('Unable to open the resource.')); }
        const result = payload.messages?.find((reply: { type?: string }) => reply.type === 'resource-preview');
        if (!result || !/^\/resource\/[a-f\d-]{36}(?:\?|$)/.test(result.url)) { throw new Error(t('Unable to open the resource.')); }
        controller.signal.throwIfAborted();
        await open(result);
      })().catch(async error => {
        if (!controller.signal.aborted) { await webview.postMessage({ type: 'workflow-host', resourceError: { type: 'error', message: error.message } }); }
      }).finally(() => pending--);
      return true;
    },
    dispose(): void { controller.abort(); },
  };
}
