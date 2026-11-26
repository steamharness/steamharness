import { BotArtifactLibrary } from './bot-artifacts';
import { BotMemoryPanel, type MemoryDirectoryScope } from './bot-memory';
import { t } from '../localization';
import type { BotPanelKind, BotPanelRequest, BotPanelResponse } from '../bot-management-protocol';
import './bot-management-standalone.css';

declare function acquireVsCodeApi(): { postMessage(message: object): void };
const host = acquireVsCodeApi();
const viewLifetime = new AbortController();
const pending = new Map<number, (result: BotPanelResponse) => void>();
let nextId = 0;
let opened = false;

function request(input: BotPanelRequest, signal?: AbortSignal): Promise<Response> {
  const stop = AbortSignal.any([viewLifetime.signal, ...(signal ? [signal] : [])]);
  if (stop.aborted) return Promise.reject(stop.reason);
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const abort = () => {
      pending.delete(id);
      if (!viewLifetime.signal.aborted) host.postMessage({ type: 'cancel', id });
      reject(stop.reason);
    };
    stop.addEventListener('abort', abort, { once: true });
    pending.set(id, ({ status, json, preview }) => {
      stop.removeEventListener('abort', abort);
      const headers = new Headers();
      if (preview) headers.set('Content-Type', preview.mime);
      if (preview?.truncated) headers.set('X-SteamHarness-Preview-Truncated', '1');
      resolve(new Response(status === 204 ? null : preview?.bytes ?? JSON.stringify(json ?? {}), { status, headers }));
    });
    host.postMessage({ type: 'request', id, request: input });
  });
}

window.addEventListener('pagehide', () => viewLifetime.abort(), { once: true });
const close = () => { viewLifetime.abort(); host.postMessage({ type: 'close' }); };

type PanelInit = { type: 'init'; kind: BotPanelKind; status: 'ready' | 'untrusted' | 'unavailable'; name?: string; instance?: boolean;
  directories?: Omit<MemoryDirectoryScope, 'selectable'> };
window.addEventListener('message', (event: MessageEvent<PanelInit | { type: 'response'; id: number; result: BotPanelResponse }>) => {
  const data = event.data;
  if (data?.type === 'response') {
    const resolve = pending.get(data.id);
    if (resolve) { pending.delete(data.id); resolve(data.result); }
  } else if (data?.type === 'init' && !opened) {
    opened = true;
    if (data.status !== 'ready') { host.postMessage({ type: 'unavailable', status: data.status }); return; }
    const identity = t(data.instance ? 'Bot instance: {0}' : 'Original Bot: {0}', data.name ?? '');
    if (data.kind === 'artifacts') {
      const artifacts = new BotArtifactLibrary({
        request: (route, init) => request({ kind: 'artifacts', route, method: init?.method ?? 'GET' }, init?.signal ?? undefined),
        save: (id, signal) => request({ kind: 'save', id }, signal), onClose: close,
      });
      artifacts.configure('ready', identity);
      artifacts.open();
    } else {
      const memory = new BotMemoryPanel({ request: (input, signal) => request({ kind: 'memory', input }, signal), onClose: close });
      memory.configure('ready', identity, data.directories && { ...data.directories, selectable: true });
      memory.open();
    }
    host.postMessage({ type: 'ready' });
  }
});
host.postMessage({ type: 'init' });
