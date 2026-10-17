import { expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

async function connectionFixture(status: number, live = true) {
  const listeners = new Map<string, (event?: { persisted: boolean }) => void>();
  const updates: string[] = [];
  const messages: Record<string, unknown>[] = [];
  const retry = vi.fn();
  const clear = vi.fn();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status })).mockResolvedValue(new Response(null, { status: 200 }));
  const navigatorState = { onLine: true };
  let source: { onopen?: () => void; url: string } | undefined;
  const compiled = await build({ entryPoints: ['src/web/ui/connection.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.css': 'empty' } });
  const module = { exports: {} as { BrowserConnection: new (emit: (message: { status: string }) => void, live?: boolean) => { request(message: Record<string, unknown>): Promise<unknown[]> } } };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, URL, URLSearchParams, AbortSignal, AbortController, crypto: { randomUUID },
    location: { href: 'http://127.0.0.1:1234/', hash: '#session=test-capability', pathname: '/', search: '' },
    navigator: navigatorState, sessionStorage: { getItem: () => null, setItem() {} }, history: { replaceState() {} },
    queueMicrotask() {}, addEventListener: (name: string, callback: (event?: { persisted: boolean }) => void) => listeners.set(name, callback),
    setTimeout: retry, clearTimeout: clear, fetch: fetcher,
    EventSource: class { onopen?: () => void; constructor(readonly url: string) { source = this; } close() {} },
  });
  const connection = new module.exports.BrowserConnection(message => { updates.push(message.status); messages.push(message); }, live);
  return { listeners, updates, messages, retry, clear, fetcher, connection, navigatorState, source: () => source };
}

it('retries temporary session errors without marking the capability expired', async () => {
  const connection = await connectionFixture(503);
  connection.listeners.get('online')!();
  await vi.waitFor(() => expect(connection.retry).toHaveBeenCalledOnce());
  expect(connection.updates).toContain('reconnecting'); expect(connection.updates).not.toContain('expired');
  connection.retry.mock.calls[0][0]();
  await vi.waitFor(() => expect(connection.source()).toBeDefined());
  connection.source()!.onopen!();
  expect(connection.updates.at(-1)).toBe('connected');
  expect(connection.fetcher).toHaveBeenCalledTimes(3);
});

it('requires a new capability after the server rejects the session with 401', async () => {
  const connection = await connectionFixture(401);
  connection.listeners.get('online')!();
  await vi.waitFor(() => expect(connection.updates).toContain('expired'));
  expect(connection.retry).not.toHaveBeenCalled(); expect(connection.source()).toBeUndefined();
});

it('binds commands and ready snapshots to the page event connection', async () => {
  const fixture = await connectionFixture(200);
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.source()!.onopen!();
  const clientId = new URL(fixture.source()!.url).searchParams.get('clientId'); expect(clientId).toBeTruthy();
  for (const type of ['kanban-method-state', 'kanban-method-reply', 'ready', 'send', 'agent-command']) {
    fixture.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] })));
    await fixture.connection.request({ type });
    const body = JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body);
    expect(body.clientId).toBe(clientId);
  }
});

it('does not reconnect a departed page from a late session handshake and restores it from browser history', async () => {
  const fixture = await connectionFixture(200);
  let finish!: (response: Response) => void;
  fixture.fetcher.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(new Response(null, { status: 200 }));
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(finish).toBeDefined());
  fixture.listeners.get('pagehide')!(); finish(new Response(null, { status: 200 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.source()).toBeUndefined(); expect(fixture.retry).not.toHaveBeenCalled();
  fixture.listeners.get('pageshow')!({ persisted: true });
  await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.source()!.onopen!();
  expect(fixture.updates.at(-1)).toBe('connected');
});

it('ignores an older handshake when offline and online events start a new connection', async () => {
  const fixture = await connectionFixture(200);
  let finish!: (response: Response) => void;
  fixture.fetcher.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(new Response(null, { status: 200 }));
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(finish).toBeDefined());
  fixture.navigatorState.onLine = false; fixture.listeners.get('offline')!();
  fixture.navigatorState.onLine = true; fixture.listeners.get('online')!();
  await vi.waitFor(() => expect(fixture.source()).toBeDefined());
  const latest = fixture.source(); latest!.onopen!(); finish(new Response(null, { status: 200 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.source()).toBe(latest); expect(fixture.updates.at(-1)).toBe('connected');
});

it('does not tear down a new event stream when an older mutation fails', async () => {
  const fixture = await connectionFixture(200);
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.source()!.onopen!();
  let fail!: (error: Error) => void;
  fixture.fetcher.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const result = expect(fixture.connection.request({ type: 'workflow-run' })).rejects.toThrow();
  await vi.waitFor(() => expect(fail).toBeDefined());
  const old = fixture.source(); fixture.navigatorState.onLine = false; fixture.listeners.get('offline')!();
  fixture.navigatorState.onLine = true; fixture.listeners.get('online')!();
  await vi.waitFor(() => expect(fixture.source()).not.toBe(old)); fixture.source()!.onopen!();
  fail(new Error('Old network request failed')); await result;
  expect(fixture.updates.at(-1)).toBe('connected'); expect(fixture.retry).not.toHaveBeenCalled();
});

it('card previews use short authenticated snapshots and still observe account changes without opening event streams', async () => {
  const fixture = await connectionFixture(200, false);
  let authenticationRevision = 1;
  fixture.fetcher.mockReset().mockImplementation(async (url, options) => {
    expect(options.headers.Authorization).toBe('Bearer test-capability');
    return new Response(JSON.stringify(url === '/api/resource-state' ? { type: 'state', authenticationRevision } : { messages: [] }));
  });
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.retry).toHaveBeenCalledOnce());
  expect(fixture.source()).toBeUndefined(); expect(fixture.updates).toContain('connected');
  expect(fixture.messages.at(-1)).toMatchObject({ authenticationRevision: 1 });
  await fixture.connection.request({ type: 'resource-data', id: 'preview' });
  authenticationRevision = 2; fixture.retry.mock.calls[0][0]();
  await vi.waitFor(() => expect(fixture.messages.at(-1)).toMatchObject({ authenticationRevision: 2 }));
  expect(fixture.source()).toBeUndefined();
  fixture.listeners.get('pagehide')!(); expect(fixture.clear).toHaveBeenCalled();
  fixture.retry.mock.calls.at(-1)![0]();
  expect(fixture.source()).toBeUndefined();
});
