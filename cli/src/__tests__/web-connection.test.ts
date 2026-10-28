import { expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import type { BrowserConnection } from '../web/ui/connection';

const compiled = build({ entryPoints: ['src/web/ui/connection.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.css': 'empty' } });

async function connectionFixture(status: number, live = true) {
  const listeners = new Map<string, (event?: { persisted: boolean }) => void>();
  const updates: string[] = [];
  const messages: Record<string, unknown>[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const retry = vi.fn((callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; });
  const clear = vi.fn((id: number) => timers.delete(id));
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status })).mockResolvedValue(new Response(null, { status: 200 }));
  const navigatorState = { onLine: true };
  class Source {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    close = vi.fn();
    events = new Map<string, () => void>();
    constructor(readonly url: string) { source = this; }
    addEventListener(name: string, callback: () => void) { this.events.set(name, callback); }
  }
  let source: Source | undefined;
  const module = { exports: {} as { BrowserConnection: typeof BrowserConnection } };
  runInNewContext((await compiled).outputFiles[0].text, {
    module, exports: module.exports, URL, URLSearchParams, AbortSignal, AbortController, crypto: { randomUUID },
    location: { href: 'http://127.0.0.1:1234/', hash: '#session=test-capability', pathname: '/', search: '' },
    navigator: navigatorState, sessionStorage: { getItem: () => null, setItem() {} }, history: { replaceState() {} },
    queueMicrotask() {}, addEventListener: (name: string, callback: (event?: { persisted: boolean }) => void) => listeners.set(name, callback),
    setTimeout: retry, clearTimeout: clear, fetch: fetcher,
    EventSource: Source, document: { querySelector: () => null },
  });
  const connection = new module.exports.BrowserConnection(message => { if (message.type === 'connection') updates.push(message.status); messages.push(message); }, live);
  const fire = (delay: number) => {
    const timer = [...timers].find(([, timer]) => timer.delay === delay);
    expect(timer, `No timer scheduled for ${delay} ms`).toBeDefined();
    timers.delete(timer![0]); timer![1].callback();
  };
  const open = (state: Record<string, unknown> = { type: 'state' }) => {
    source!.onopen!(); source!.onmessage!({ data: JSON.stringify(state) });
  };
  return { listeners, updates, messages, retry, clear, fetcher, connection, navigatorState, timers, fire, open, source: () => source };
}

it('retries temporary session errors without marking the capability expired', async () => {
  const connection = await connectionFixture(503);
  connection.listeners.get('online')!();
  await vi.waitFor(() => expect([...connection.timers.values()].map(timer => timer.delay)).toEqual([2_000]));
  expect(connection.updates).toContain('reconnecting'); expect(connection.updates).not.toContain('expired');
  connection.fire(2_000);
  await vi.waitFor(() => expect(connection.source()).toBeDefined());
  connection.open();
  expect(connection.updates.at(-1)).toBe('connected');
  expect(connection.fetcher).toHaveBeenCalledTimes(3);
});

it('requires a new capability after the server rejects the session with 401', async () => {
  const connection = await connectionFixture(401);
  connection.listeners.get('online')!();
  await vi.waitFor(() => expect(connection.updates).toContain('expired'));
  expect(connection.timers.size).toBe(0); expect(connection.source()).toBeUndefined();
});

it('binds commands and ready snapshots to the page event connection', async () => {
  const fixture = await connectionFixture(200);
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.open();
  const clientId = new URL(fixture.source()!.url).searchParams.get('clientId'); expect(clientId).toBeTruthy();
  for (const type of ['kanban-method-state', 'kanban-method-reply', 'ready', 'send', 'agent-command']) {
    fixture.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] })));
    await fixture.connection.request({ type });
    const body = JSON.parse(fixture.fetcher.mock.calls.at(-1)![1].body);
    expect(body.clientId).toBe(clientId);
  }
});

it('keeps the event connection alive while a full application recheck exceeds an ordinary request deadline', async () => {
  const fixture = await connectionFixture(200);
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.open();
  const ordinaryDeadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms <= 60_000 ? ordinaryDeadline.signal : new AbortController().signal);
  let finish!: (response: Response) => void, signal: AbortSignal | undefined;
  fixture.fetcher.mockImplementationOnce((_url, options) => new Promise((resolve, reject) => {
    signal = options.signal; finish = resolve;
    signal!.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
  }));
  try {
    const checking = fixture.connection.request({ type: 'project-server-check' });
    ordinaryDeadline.abort();
    expect(signal?.aborted).toBe(false); expect(fixture.updates.at(-1)).toBe('connected');
    finish(Response.json({ messages: [{ type: 'project-server-checked' }] }));
    await expect(checking).resolves.toEqual([{ type: 'project-server-checked' }]);
    expect(fixture.fetcher.mock.calls.filter(([url]) => url === '/api/message')).toHaveLength(1);
  } finally { timeout.mockRestore(); }
});

it('does not reconnect a departed page from a late session handshake and restores it from browser history', async () => {
  const fixture = await connectionFixture(200);
  let finish!: (response: Response) => void;
  fixture.fetcher.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(new Response(null, { status: 200 }));
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(finish).toBeDefined());
  fixture.listeners.get('pagehide')!(); finish(new Response(null, { status: 200 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.source()).toBeUndefined(); expect(fixture.timers.size).toBe(0);
  fixture.listeners.get('pageshow')!({ persisted: true });
  await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.open();
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
  const latest = fixture.source(); fixture.open(); finish(new Response(null, { status: 200 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.source()).toBe(latest); expect(fixture.updates.at(-1)).toBe('connected');
});

it('does not tear down a new event stream when an older mutation fails', async () => {
  const fixture = await connectionFixture(200);
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.open();
  let fail!: (error: Error) => void;
  fixture.fetcher.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const result = expect(fixture.connection.request({ type: 'workflow-run' })).rejects.toThrow();
  await vi.waitFor(() => expect(fail).toBeDefined());
  const old = fixture.source(); fixture.navigatorState.onLine = false; fixture.listeners.get('offline')!();
  fixture.navigatorState.onLine = true; fixture.listeners.get('online')!();
  await vi.waitFor(() => expect(fixture.source()).not.toBe(old)); fixture.open();
  fail(new Error('Old network request failed')); await result;
  expect(fixture.updates.at(-1)).toBe('connected'); expect([...fixture.timers.values()].map(timer => timer.delay)).toEqual([45_000]);
});

it.each(['queue-promote', 'queue-remove'])('times out a stalled %s request and reconnects without automatically replaying it', async type => {
  const fixture = await connectionFixture(200);
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.open();
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
  try {
    fixture.fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
    }));
    const pending = expect(fixture.connection.request({ type, requestId: randomUUID(), sessionId: 'original', id: 'queued' })).rejects.toThrow('Connection interrupted.');
    expect(timeout).toHaveBeenCalledWith(35_000);
    controller.abort(); await pending;
    expect(fixture.updates.at(-1)).toBe('reconnecting');
    const old = fixture.source();
    fixture.fire(2_000); await vi.waitFor(() => expect(fixture.source()).not.toBe(old)); fixture.open();
    expect(fixture.updates.at(-1)).toBe('connected');
    expect(fixture.fetcher.mock.calls.filter(([url]) => url === '/api/message')).toHaveLength(1);
  } finally { timeout.mockRestore(); }
});

it('times out a stream that opens without a snapshot and reconnects without waiting for an error event', async () => {
  const fixture = await connectionFixture(200);
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.source()).toBeDefined());
  const old = fixture.source()!; old.onopen!();
  expect(fixture.updates).not.toContain('connected');
  fixture.fire(10_000);
  expect(old.close).toHaveBeenCalledOnce(); expect(fixture.updates.at(-1)).toBe('reconnecting');
  fixture.fire(2_000);
  await vi.waitFor(() => expect(fixture.source()).not.toBe(old));
  fixture.open({ type: 'state', running: false });
  expect(fixture.updates.at(-1)).toBe('connected');
  expect(fixture.messages).toContainEqual({ type: 'state', running: false });
});

it('starts another attempt when a session handshake hangs, even if abort has not settled its fetch', async () => {
  const fixture = await connectionFixture(200);
  let signal!: AbortSignal;
  fixture.fetcher.mockImplementationOnce((_url, options) => { signal = options.signal; return new Promise(() => {}); });
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(signal).toBeDefined());
  fixture.fire(10_000);
  expect(signal.aborted).toBe(true); expect(fixture.updates.at(-1)).toBe('reconnecting');
  fixture.fire(2_000);
  await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.open();
  expect(fixture.updates.at(-1)).toBe('connected');
});

it('manual Retry cancels a pending attempt and reads a new snapshot immediately', async () => {
  const fixture = await connectionFixture(200);
  let finish!: (response: Response) => void, signal!: AbortSignal;
  fixture.fetcher.mockImplementationOnce((_url, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); });
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(finish).toBeDefined());
  const reconnect = fixture.connection.reconnect();
  expect(signal.aborted).toBe(true);
  expect(fixture.messages.at(-1)).toMatchObject({ status: 'reconnecting', manual: true });
  await vi.waitFor(() => expect(fixture.source()).toBeDefined());
  fixture.open({ type: 'state', running: false, sessions: [{ id: 'existing', queuedInputs: [{ id: 'queued' }] }] });
  await reconnect;
  finish(new Response(null, { status: 200 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fixture.messages.at(-1)).toMatchObject({ status: 'connected', manual: false });
  expect(fixture.fetcher.mock.calls.every(([url]) => url === '/api/session')).toBe(true);
  expect([...fixture.timers.values()].map(timer => timer.delay)).toEqual([45_000]);
});

it('releases obsolete HTTP requests on Retry without replaying them or interrupting a pending stop', async () => {
  const fixture = await connectionFixture(200);
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.open();
  let oldSignal!: AbortSignal, stopSignal!: AbortSignal, finishOld!: (response: Response) => void, finishStop!: (response: Response) => void;
  fixture.fetcher.mockImplementationOnce((_url, options) => { oldSignal = options.signal; return new Promise(resolve => { finishOld = resolve; }); });
  const old = expect(fixture.connection.request({ type: 'resource-data' })).rejects.toThrow('Connection changed.');
  fixture.fetcher.mockImplementationOnce((_url, options) => { stopSignal = options.signal; return new Promise(resolve => { finishStop = resolve; }); });
  const stopping = fixture.connection.request({ type: 'agent-command', command: { type: 'cancel', requestId: 'stop' }, sessionId: 'original' });
  const previous = fixture.source();
  const reconnecting = fixture.connection.reconnect();
  expect(oldSignal.aborted).toBe(true); expect(stopSignal.aborted).toBe(false);
  await vi.waitFor(() => expect(fixture.source()).not.toBe(previous)); fixture.open(); await reconnecting;
  finishOld(new Response(JSON.stringify({ messages: [{ type: 'state', stale: true }] }))); await old;
  finishStop(new Response(JSON.stringify({ messages: [{ type: 'stopped', sessionId: 'original' }] })));
  expect(await stopping).toEqual([{ type: 'stopped', sessionId: 'original' }]);
  expect(fixture.updates.at(-1)).toBe('connected');
  expect(fixture.fetcher.mock.calls.filter(([url]) => url === '/api/message')).toHaveLength(2);
});

it('aborts a departed page during response-body reads, including cancellation requests', async () => {
  const fixture = await connectionFixture(200);
  let signal!: AbortSignal, finish!: (reply: object) => void;
  fixture.fetcher.mockReset().mockImplementationOnce(async (_url, options) => {
    signal = options.signal;
    return { ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) };
  });
  const result = expect(fixture.connection.request({ type: 'stop' })).rejects.toThrow('Connection changed.');
  await vi.waitFor(() => expect(finish).toBeDefined()); fixture.listeners.get('pagehide')!();
  expect(signal.aborted).toBe(true);
  finish({ messages: [{ type: 'state' }] }); await result;
  expect(fixture.source()).toBeUndefined();
});

it('reports a failed manual attempt and resets the feedback on a successful retry', async () => {
  const fixture = await connectionFixture(503);
  await fixture.connection.reconnect();
  expect(fixture.messages.at(-1)).toMatchObject({ status: 'reconnecting', manual: false, retryFailed: true });
  const reconnect = fixture.connection.reconnect();
  expect(fixture.messages.at(-1)).toMatchObject({ manual: true, retryFailed: false });
  await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.fire(10_000);
  expect(fixture.messages.at(-1)).toMatchObject({ manual: false, retryFailed: true });
  await reconnect;
  const previous = fixture.source();
  const retry = fixture.connection.reconnect();
  await vi.waitFor(() => expect(fixture.source()).not.toBe(previous)); fixture.open(); await retry;
  expect(fixture.messages.at(-1)).toMatchObject({ status: 'connected', manual: false, retryFailed: false });
});

it.each(['stop', 'cancel'])('bounds a stalled %s control even while the event stream is unavailable', async type => {
  const fixture = await connectionFixture(200);
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
  try {
    fixture.fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
    }));
    const pending = expect(fixture.connection.request(type === 'stop' ? { type } : { type: 'agent-command', command: { type: 'cancel' } })).rejects.toThrow('Connection interrupted.');
    expect(timeout).toHaveBeenCalledWith(35_000);
    controller.abort(); await pending;
    expect(fixture.updates.at(-1)).toBe('reconnecting');
  } finally { timeout.mockRestore(); }
});

it('keeps retrying a temporary outage with bounded backoff and reconnects when the service recovers', async () => {
  const fixture = await connectionFixture(503);
  fixture.fetcher.mockResolvedValue(new Response(null, { status: 503 }));
  fixture.listeners.get('online')!();
  for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    await vi.waitFor(() => expect([...fixture.timers.values()].map(timer => timer.delay)).toEqual([delay]));
    fixture.fire(delay);
  }
  await vi.waitFor(() => expect([...fixture.timers.values()].map(timer => timer.delay)).toEqual([30_000]));
  fixture.fetcher.mockResolvedValue(new Response(null, { status: 200 })); fixture.fire(30_000);
  await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.open();
  expect(fixture.updates.at(-1)).toBe('connected'); expect(fixture.updates).not.toContain('expired');
});

it('detects a silent event stream, renews its heartbeat deadline and ignores obsolete callbacks', async () => {
  const fixture = await connectionFixture(200);
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.open();
  const old = fixture.source()!, deadline = [...fixture.timers.keys()][0];
  old.events.get('heartbeat')!();
  expect(fixture.timers.has(deadline)).toBe(false);
  expect([...fixture.timers.values()].map(timer => timer.delay)).toEqual([45_000]);
  fixture.fire(45_000);
  expect(old.close).toHaveBeenCalledOnce(); expect(fixture.updates.at(-1)).toBe('reconnecting');
  fixture.fire(2_000); await vi.waitFor(() => expect(fixture.source()).not.toBe(old)); fixture.open();
  const count = fixture.messages.length;
  old.onopen!(); old.onerror!(); old.onmessage!({ data: '{"type":"state","running":true}' }); old.events.get('heartbeat')!();
  expect(fixture.messages).toHaveLength(count); expect(fixture.updates.at(-1)).toBe('connected');
});

it('retries an invalid state frame instead of leaving the connection apparently healthy', async () => {
  const fixture = await connectionFixture(200);
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect(fixture.source()).toBeDefined()); fixture.open();
  const old = fixture.source()!;
  old.onmessage!({ data: 'incomplete state' });
  expect(old.close).toHaveBeenCalledOnce(); expect(fixture.updates.at(-1)).toBe('reconnecting');
  fixture.fire(2_000); await vi.waitFor(() => expect(fixture.source()).not.toBe(old)); fixture.open();
  expect(fixture.updates.at(-1)).toBe('connected');
});

it('card previews use short authenticated snapshots and still observe account changes without opening event streams', async () => {
  const fixture = await connectionFixture(200, false);
  let authenticationRevision = 1;
  fixture.fetcher.mockReset().mockImplementation(async (url, options) => {
    expect(options.headers.Authorization).toBe('Bearer test-capability');
    return new Response(JSON.stringify(url === '/api/resource-state' ? { type: 'state', authenticationRevision } : { messages: [] }));
  });
  fixture.listeners.get('online')!(); await vi.waitFor(() => expect([...fixture.timers.values()].map(timer => timer.delay)).toEqual([5_000]));
  expect(fixture.source()).toBeUndefined(); expect(fixture.updates).toContain('connected');
  expect(fixture.messages.at(-1)).toMatchObject({ authenticationRevision: 1 });
  await fixture.connection.request({ type: 'resource-data', id: 'preview' });
  authenticationRevision = 2; fixture.fire(5_000);
  await vi.waitFor(() => expect(fixture.messages.at(-1)).toMatchObject({ authenticationRevision: 2 }));
  expect(fixture.source()).toBeUndefined();
  fixture.listeners.get('pagehide')!(); expect(fixture.clear).toHaveBeenCalled();
  fixture.retry.mock.calls.at(-1)![0]();
  expect(fixture.source()).toBeUndefined();
});
