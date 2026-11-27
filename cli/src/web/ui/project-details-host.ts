import { isProjectUsageSnapshot, projectUsageKey, type ProjectUsageBridge, type ProjectUsageSnapshot, type ProjectUsageSnapshots, type UsagePart } from '@steamharness/project-info/local-usage';

interface DetailsHost { version: 1; revision: string; localUsage: boolean; webCredentials?: boolean }
interface Pending {
  part: UsagePart;
  resolve(snapshot?: ProjectUsageSnapshot): void;
  timer: ReturnType<typeof setTimeout>;
}

export function projectDetailsHost(copyText?: (text: string) => Promise<boolean>) {
  let current: DetailsHost | undefined, origin = '';
  let cache: { key: string; snapshots: ProjectUsageSnapshots } | undefined;
  const pending = new Map<string, Pending>();
  const send = (requestId: string, action: { part: UsagePart } | { cancel: true }) => {
    window.parent.postMessage({ type: 'workflow-project-usage', version: 1, revision: current!.revision, requestId, ...action }, origin === 'null' ? '*' : origin);
  };
  const finish = (id: string, snapshot?: ProjectUsageSnapshot) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id); clearTimeout(request.timer); request.resolve(snapshot);
  };
  const bridge: ProjectUsageBridge = {
    cached: target => cache?.key === projectUsageKey(target) ? cache.snapshots : {},
    remember: (target, snapshot) => {
      const key = projectUsageKey(target);
      if (cache?.key !== key) cache = { key, snapshots: {} };
      cache.snapshots[snapshot.part] = snapshot;
    },
    read: (_target, part, id) => new Promise(resolve => {
      if (!current?.localUsage) { resolve(undefined); return; }
      const timer = setTimeout(() => { finish(id); send(id, { cancel: true }); }, 40_000);
      pending.set(id, { part, resolve, timer });
      try { send(id, { part }); } catch { finish(id); }
    }),
    cancel: id => { if (pending.has(id)) { finish(id); send(id, { cancel: true }); } },
    copy: text => { void copyText?.(text); },
  };
  if (window.parent !== window) {
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.data?.type !== 'workflow-host') return;
      const host = event.data.projectDetails as DetailsHost | undefined;
      if (host?.version === 1 && typeof host.revision === 'string' && host.revision.length > 0 && host.revision.length <= 64 && typeof host.localUsage === 'boolean') {
        if (host.revision !== current?.revision) { for (const id of pending.keys()) finish(id); cache = undefined; }
        current = host; origin = event.origin;
      }
      const response = event.data.projectUsage;
      if (!current || event.origin !== origin || response?.version !== 1 || response.revision !== current.revision) return;
      const request = pending.get(response.requestId);
      if (!request) return;
      const snapshot = response.snapshot;
      if (snapshot === undefined || isProjectUsageSnapshot(snapshot) && snapshot.part === request.part) finish(response.requestId, snapshot);
    });
    window.addEventListener('pagehide', () => { for (const id of pending.keys()) bridge.cancel(id); });
  }
  return {
    get studio() { return !!current; },
    get usage() { return current?.localUsage ? bridge : undefined; },
    get webCredentials() { return current?.webCredentials === true; },
    openWebCredentials() {
      if (current?.webCredentials === true) {
        window.parent.postMessage({ type: 'workflow-bot-credentials', version: 1, revision: current.revision }, origin === 'null' ? '*' : origin);
      }
    },
  };
}
