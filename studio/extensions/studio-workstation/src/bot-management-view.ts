import * as vscode from 'vscode';
import path from 'node:path';
import { homedir } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { BotArtifactResult } from '../../../../cli/src/web/bot-artifacts';
import { botArtifactId, botArtifactRoute, type BotPanelKind, type BotPanelRequest, type BotPanelResponse } from '../../../../cli/src/web/bot-management-protocol';
import { resolveBotStorageTarget, type BotStorageTarget } from './bot-management-target';

const viewType = 'studio.launchpadBotManagement';
type Operation = Exclude<BotPanelRequest, { kind: 'save' }>;
type TargetInput = { kind: BotPanelKind; uri: string; entryId?: string; projectId?: string; owner: string | null };

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

async function storageRequest(workerFile: string, target: BotStorageTarget, request: Operation, signal: AbortSignal): Promise<BotArtifactResult> {
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
      const requests = new Map<number, AbortController>();
      const { webview } = view;
      const stop = () => lifetime.abort();
      const cancellation = token.onCancellationRequested(stop);
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
      const receive = webview.onDidReceiveMessage(async (message: { type?: string; id?: number; request?: unknown } | undefined) => {
        if (!message || lifetime.signal.aborted || !input) return;
        if (message.type === 'init') {
          const selected = await (selection ??= scope());
          if (lifetime.signal.aborted) return;
          const target = selected && selected !== 'untrusted' ? selected.target : undefined;
          void webview.postMessage({ type: 'init', kind: input.kind, status: target ? 'ready' : selected === 'untrusted' ? 'untrusted' : 'unavailable',
            name: target?.name, instance: target?.instance, directories: target?.directories });
          return;
        }
        if (!Number.isSafeInteger(message.id) || message.id! < 1) return;
        const id = message.id!;
        if (message.type === 'cancel') { requests.get(id)?.abort(); return; }
        if (message.type !== 'request' || requests.has(id)) return;
        const request = readRequest(input.kind, message.request);
        const respond = (result: BotPanelResponse) => { if (!lifetime.signal.aborted) void webview.postMessage({ type: 'response', id, result }); };
        if (!request || requests.size >= 4) { respond({ status: 400 }); return; }
        const job = new AbortController();
        requests.set(id, job);
        try {
          const selected = await (selection ??= scope());
          if (!selected || selected === 'untrusted') { respond({ status: 403 }); return; }
          const signal = AbortSignal.any([selected.signal, job.signal]);
          const allowed = () => !signal.aborted && vscode.workspace.isTrusted && options.currentOwner() === input.owner;
          if (!allowed()) { respond({ status: 403 }); return; }
          const run = (action: Operation) => storageRequest(workerFile, selected.target, action, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
          if (request.kind === 'save') {
            const meta = await run({ kind: 'artifacts', route: `/${request.id}`, method: 'GET' });
            if (!allowed()) { respond({ status: 403 }); return; }
            const name = 'json' in meta ? (meta.json as { name?: string })?.name : undefined;
            if (!name) { respond({ status: meta.status }); return; }
            const filename = path.win32.basename(name).replace(/[\u0000-\u001f<>:"|?*]/gu, '_');
            const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(homedir(), 'Downloads', !filename || filename === '.' || filename === '..' ? request.id : filename)) });
            if (!destination || !allowed()) { respond({ status: 204 }); return; }
            const result = await run({ kind: 'artifacts', route: `/${request.id}/content`, method: 'GET' });
            if (!allowed() || destination.scheme !== 'file') { respond({ status: 403 }); return; }
            if ('content' in result) await vscode.workspace.fs.writeFile(destination, result.content.bytes);
            respond({ status: result.status });
            return;
          }
          const result = await run(request);
          if (!allowed()) { respond({ status: 403 }); return; }
          respond('json' in result ? result : { status: result.status, preview: { bytes: Uint8Array.from(result.content.bytes).buffer,
            mime: result.content.mime, truncated: result.content.truncated } });
        } catch { if (!job.signal.aborted) respond({ status: 500 }); }
        finally { requests.delete(id); }
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
