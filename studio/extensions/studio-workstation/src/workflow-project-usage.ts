import type { Webview } from 'vscode';
import type { ProjectUsageSnapshot, UsagePart } from './project-usage-types';

type UsageReader = (input: { id: string; cancel: true } | {
  id: string; uri: string; identity: string; managed: boolean; part: UsagePart; refresh: true;
}) => Promise<ProjectUsageSnapshot | undefined> | undefined;

export function bindProjectUsage(webview: Pick<Webview, 'postMessage'>, target: { uri: string; identity: string; managed: boolean },
  active: () => boolean, read?: UsageReader) {
  let revision = '', disposed = false;
  const pending = new Map<string, { id: string; part: UsagePart }>();
  const cancel = (requestId: string): void => {
    const request = pending.get(requestId);
    if (request) { pending.delete(requestId); void read?.({ id: request.id, cancel: true }); }
  };
  const clear = () => { for (const requestId of pending.keys()) cancel(requestId); };
  return {
    frame() {
      clear(); revision = globalThis.crypto.randomUUID();
      return { version: 1 as const, revision, localUsage: !!read };
    },
    clear,
    receive(message: Record<string, unknown> | undefined): boolean {
      if (message?.type !== 'workflow-project-usage') return false;
      const { requestId, part } = message;
      if (disposed || !read || message.version !== 1 || !revision || message.revision !== revision
        || typeof requestId !== 'string' || !/^[a-f\d-]{36}$/iu.test(requestId)) return true;
      if (message.cancel === true) { cancel(requestId); return true; }
      if (!active() || (part !== 'directory' && part !== 'runtime') || pending.has(requestId) || [...pending.values()].some(request => request.part === part)) return true;
      const request: { id: string; part: UsagePart } = { id: globalThis.crypto.randomUUID(), part };
      pending.set(requestId, request);
      const complete = (snapshot?: ProjectUsageSnapshot) => {
        if (pending.get(requestId) !== request) return;
        pending.delete(requestId);
        if (!disposed && active()) void webview.postMessage({ type: 'workflow-host', projectUsage: { version: 1, revision, requestId, snapshot } });
      };
      // The target is captured from the active project, not from the frame message.
      void Promise.resolve().then(() => pending.get(requestId) === request ? read({ ...target, ...request, refresh: true }) : undefined).then(complete, () => complete());
      return true;
    },
    dispose() { disposed = true; clear(); },
  };
}
