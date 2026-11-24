import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { t } from './localization';
import type { RemoteAccessHandler } from './remote-access-types';

interface Endpoint { port: number; key: string }
function parse(value: string): Endpoint {
  const endpoint = JSON.parse(value) as Endpoint;
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535 || !/^[\w-]{43}$/.test(endpoint.key)) throw new Error('Invalid Studio Web control endpoint.');
  return endpoint;
}

async function control<T>(endpoint: Endpoint, route: string, body: unknown, timeout = 4000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/${route}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return await response.json() as T;
}

export const usingStudioWeb = () => !!process.env.STEAMHARNESS_STUDIO_WEB_REGISTRY && vscode.env.uiKind === vscode.UIKind.Web;

export function remoteAccessHandler(): RemoteAccessHandler | undefined {
  const desktop = process.env.STEAMHARNESS_STUDIO_WEB_DESKTOP_CONTROL;
  if (usingStudioWeb()) return async input => await vscode.commands.executeCommand('studio.internalWebAccess', 'manage', input);
  if (!desktop || vscode.env.uiKind !== vscode.UIKind.Desktop || vscode.env.remoteName) return;
  return input => control(parse(desktop), 'manage', input, input.action === 'start' ? 300_000 : 8000);
}

function registerTarget(endpoint: Endpoint, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error(t('Unable to open the remote preview.')));
    const requestOptions = { method: 'POST', agent: false, signal,
      headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' } } as const;
    const req = request(`http://127.0.0.1:${endpoint.port}/targets`, requestOptions, response => {
      response.once('error', fail);
      response.once('close', fail);
      if (response.statusCode !== 200) { response.resume(); fail(); return; }
      let line = '';
      response.setEncoding('utf8').on('data', (chunk: string) => {
        if (line.includes('\n')) return;
        line += chunk;
        if (line.length > 128) { fail(); return; }
        if (!line.includes('\n')) return;
        try {
          const { id } = JSON.parse(line) as { id?: string };
          if (typeof id === 'string' && /^[\w-]{43}$/.test(id)) resolve(id);
          else fail();
        } catch { fail(); }
      });
    });
    req.once('error', fail);
    req.end(JSON.stringify(input));
  });
}

/** Register only a URL returned by the local CLI or the built-in app runner. */
export async function studioPreview(source: string, kind: 'project' | 'hosted') {
  const local = new URL(source);
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || !local.port || local.username || local.password) throw new Error(t('Unable to open the remote preview.'));
  const endpoint = parse(await readFile(process.env.STEAMHARNESS_STUDIO_WEB_REGISTRY!, 'utf8'));
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(), 4000);
  let id: string | undefined, disposing: Promise<void> | undefined;
  const dispose = () => disposing ??= (async () => {
    lifetime.abort();
    if (id) await control(endpoint, 'targets', { action: 'unregister', id }).catch(() => undefined);
  })();
  try {
    id = await registerTarget(endpoint, { action: 'register', port: Number(local.port), kind }, lifetime.signal);
    clearTimeout(timer);
    const result = await vscode.commands.executeCommand<{ url?: string }>('studio.internalWebAccess', 'preview', { id });
    if (!result?.url) throw new Error(t('Unable to open the remote preview.'));
    return { url: new URL(result.url + local.pathname + local.search + local.hash), mount: result.url, dispose };
  } catch (error) { await dispose(); throw error; }
  finally { clearTimeout(timer); }
}
