import * as vscode from 'vscode';
import path from 'node:path';
import { homedir } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { BotArtifactResult } from '../../../../cli/src/web/bot-artifacts';
import { botArtifactId, botArtifactRoute, type BotPanelKind, type BotPanelRequest, type BotPanelResponse } from '../../../../cli/src/web/bot-management-protocol';
import type { BotStorageScope } from '../../../../cli/src/web/bot-management-storage';
import { resolveBotStorageTarget, type BotStorageTarget } from './bot-management-target';

const viewType = 'studio.launchpadBotManagement';
const maxConcurrentRequests = 4;
type Operation = Exclude<BotPanelRequest, { kind: 'save' }>;
type TargetInput = { kind: BotPanelKind; uri: string; entryId?: string; projectId?: string; owner: string | null };
type Selection = { target: BotStorageTarget; signal: AbortSignal };
type Job = { controller: AbortController; run(): Promise<void> };

function readTarget(value: unknown): TargetInput | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  const { kind, uri, entryId, projectId, owner } = input;
  if ((kind === 'artifacts' || kind === 'memory') && typeof uri === 'string' && (entryId === undefined || typeof entryId === 'string')
    && (projectId === undefined || typeof projectId === 'string') && (owner === null || typeof owner === 'string')) return { kind, uri, projectId, entryId, owner };
}

function readRequest(panel: BotPanelKind, value: unknown): BotPanelRequest | undefined {
  if (!value || typeof value !== 'object') return;
  const input = value as Record<string, unknown>;
  if (panel === 'memory' && input.kind === 'memory' && input.input && typeof input.input === 'object' && !Array.isArray(input.input)
    && Buffer.byteLength(JSON.stringify(input.input)) <= 96 * 1024) return { kind: 'memory', input: input.input };
  if (panel !== 'artifacts') return;
  if (input.kind === 'save' && typeof input.id === 'string' && botArtifactId.test(input.id)) return { kind: 'save', id: input.id };
  if (input.kind === 'artifacts' && typeof input.route === 'string' && input.route.length < 100 && botArtifactRoute.test(input.route)
    && (input.method === 'GET' || input.method === 'DELETE' && botArtifactId.test(input.route.slice(1)))) {
    return { kind: 'artifacts', route: input.route, method: input.method };
  }
}

async function storageRequest(workerFile: string, target: BotStorageScope, request: Operation, signal: AbortSignal): Promise<BotArtifactResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { name: 'Studio Bot storage', execArgv: [], workerData: { target, request } });
    let finished = false;
    const finish = (result?: BotArtifactResult) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      void worker.terminate().catch(() => undefined).then(() => result ? resolve(result) : reject(new Error('Bot storage request stopped.')));
    };
    const abort = () => finish();
    worker.once('message', finish);
    worker.once('error', abort);
    worker.once('exit', abort);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function registerBotManagementView(context: vscode.ExtensionContext, options: {
  captureScope(): Promise<{ workspace?: { owner: string }; data: string; lifetime: AbortController }>;
  currentOwner(): string | null;
  target: Omit<Parameters<typeof resolveBotStorageTarget>[1], 'storage'>;
}): vscode.Disposable {
  const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
  const workerFile = path.join(dist.fsPath, 'bot-management-worker.mjs');
  return vscode.window.registerWebviewViewProvider(viewType, {
    resolveWebviewView(view, state, token) {
      const input = readTarget(state.state);
      const lifetime = new AbortController();
      const requests = new Map<number, Job>();
      const queued = new Set<number>();
      let running = 0;
      const { webview } = view;
      const stop = () => { lifetime.abort(); queued.clear(); requests.clear(); };
      const cancellation = token.onCancellationRequested(stop);
      const post = (message: object) => {
        if (!lifetime.signal.aborted) void Promise.resolve(webview.postMessage(message)).catch(() => undefined);
      };
      const pump = () => {
        while (!lifetime.signal.aborted && running < maxConcurrentRequests && queued.size) {
          const id = queued.values().next().value!;
          queued.delete(id);
          ++running;
          void requests.get(id)!.run().finally(() => { requests.delete(id); --running; pump(); });
        }
      };
      const scope = async () => {
        if (!input || lifetime.signal.aborted || input.owner !== options.currentOwner()) return;
        if (!vscode.workspace.isTrusted) return 'untrusted' as const;
        const scope = await options.captureScope().catch(() => undefined);
        if (!scope || (scope.workspace?.owner ?? null) !== input.owner || lifetime.signal.aborted) return;
        const signal = AbortSignal.any([lifetime.signal, scope.lifetime.signal]);
        const target = await resolveBotStorageTarget(input, { ...options.target, storage: scope.data }).catch(() => undefined);
        if (signal.aborted || !vscode.workspace.isTrusted || input.owner !== options.currentOwner()) return;
        return target && target !== 'untrusted' ? { target, signal } : target;
      };
      let selection: ReturnType<typeof scope> | undefined;
      const authorized = async (selected: Selection, signal: AbortSignal) => {
        const allowed = () => !signal.aborted && vscode.workspace.isTrusted && options.currentOwner() === input?.owner;
        return allowed() && await selected.target.recheck() && allowed();
      };
      const perform = async (selected: Selection, request: BotPanelRequest, jobSignal: AbortSignal): Promise<BotPanelResponse> => {
        const signal = AbortSignal.any([selected.signal, jobSignal]);
        if (!await authorized(selected, signal)) return { status: 403 };
        const run = (action: Operation) => storageRequest(workerFile, selected.target.storage, action, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
        if (request.kind === 'save') {
          const meta = await run({ kind: 'artifacts', route: `/${request.id}`, method: 'GET' });
          if (!await authorized(selected, signal)) return { status: 403 };
          const name = 'json' in meta ? (meta.json as { name?: string })?.name : undefined;
          if (!name) return { status: meta.status };
          const filename = path.win32.basename(name).replace(/[\u0000-\u001f<>:"|?*]/gu, '_');
          const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(homedir(), 'Downloads', !filename || filename === '.' || filename === '..' ? request.id : filename)) });
          if (!destination) return { status: 204 };
          if (destination.scheme !== 'file' || !await authorized(selected, signal)) return { status: 403 };
          const result = await run({ kind: 'artifacts', route: `/${request.id}/content`, method: 'GET' });
          if (!await authorized(selected, signal)) return { status: 403 };
          if ('content' in result) await vscode.workspace.fs.writeFile(destination, result.content.bytes);
          return { status: result.status };
        }
        const result = await run(request);
        if (!await authorized(selected, signal)) return { status: 403 };
        return 'json' in result ? result : { status: result.status, preview: { bytes: Uint8Array.from(result.content.bytes).buffer,
          mime: result.content.mime, truncated: result.content.truncated } };
      };
      const receive = webview.onDidReceiveMessage(async (message: { type?: string; id?: number; request?: unknown } | undefined) => {
        if (!message || lifetime.signal.aborted || !input) return;
        if (message.type === 'init') {
          const selected = await (selection ??= scope());
          if (lifetime.signal.aborted) return;
          const target = selected && selected !== 'untrusted' && await authorized(selected, selected.signal) ? selected.target : undefined;
          post({ type: 'init', kind: input.kind, status: target ? 'ready' : selected === 'untrusted' ? 'untrusted' : 'unavailable',
            name: target?.name, instance: target?.instance, directories: target?.storage.directories });
          return;
        }
        if (!Number.isSafeInteger(message.id) || message.id! < 1) return;
        const id = message.id!;
        if (message.type === 'cancel') {
          requests.get(id)?.controller.abort();
          if (queued.delete(id)) requests.delete(id);
          return;
        }
        if (message.type !== 'request' || requests.has(id)) return;
        const request = readRequest(input.kind, message.request);
        const respond = (result: BotPanelResponse) => post({ type: 'response', id, result });
        if (!request) { respond({ status: 400 }); return; }
        // An aborted worker still occupies a running slot until it exits, but must not reject its replacement.
        if ([...requests.values()].filter(job => !job.controller.signal.aborted).length >= maxConcurrentRequests) {
          respond({ status: 429 }); return;
        }
        const controller = new AbortController();
        requests.set(id, { controller, async run() {
          let result: BotPanelResponse;
          try {
            const selected = await (selection ??= scope());
            result = !selected || selected === 'untrusted' ? { status: 403 }
              : await perform(selected, request, controller.signal);
          } catch { result = { status: 500 }; }
          if (!controller.signal.aborted) respond(result);
        } });
        queued.add(id);
        pump();
      });
      view.onDidDispose(() => { stop(); receive.dispose(); cancellation.dispose(); });
      const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, name)).toString();
      const nonce = globalThis.crypto.randomUUID().replace(/-/gu, '');
      const language = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
      webview.options = { enableScripts: true, localResourceRoots: [dist] };
      webview.html = `<!DOCTYPE html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src blob:; script-src 'nonce-${nonce}';">
        <link rel="stylesheet" href="${asset('codicons/codicon.css')}"><link rel="stylesheet" href="${asset('bot-management-ui.css')}"><link rel="stylesheet" href="${asset('scrollbars.css')}">
        </head><body><script nonce="${nonce}" src="${asset('bot-management-ui.js')}"></script></body></html>`;
    },
  });
}
