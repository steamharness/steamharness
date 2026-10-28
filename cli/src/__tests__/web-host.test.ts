import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { startWebServer } from '../web/server';
import { main } from '../web';

vi.mock('../web/server', () => ({ startWebServer: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); });

it('processes logout and close while an earlier host authentication is pending', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const setHostConnection = vi.fn(async (connection?: { serverUrl: string; accessToken: string }) => { if (connection) { await pending; } });
  const close = vi.fn(async () => {});
  const setHostResourceProjects = vi.fn();
  const setHostUserSettings = vi.fn();
  const resourceProjects = [path.join(os.tmpdir(), 'aggregate')];
  const connection = { serverUrl: 'https://steamharness.test', accessToken: 'host-test-token' };
  const systemAiConnection = { serverUrl: 'https://ai.test', accessToken: 'ai-test-token' };
  vi.mocked(startWebServer).mockResolvedValue({
    url: `http://127.0.0.1:3000/#session=${'a'.repeat(64)}`,
    manifest:{entries:[],defaultEntry:'main'}, project: { id: 'host-test', name: 'Host test', projectType: 'conversation', runtime: { harnessVersion: 'test', harnessPath: 'test' } },
    setHostConnection, setHostResourceProjects, setHostUserSettings, close,
  } as unknown as Awaited<ReturnType<typeof startWebServer>>);
  const input = Readable.from([
    JSON.stringify({ type: 'configure', surface: 'editor', connection, systemAiConnection, userSettings: { agent: { permissionPolicy: 'auto' } } }),
    JSON.stringify({ type: 'auth', connection, systemAiConnection: { ...systemAiConnection, accessToken: 'rotated-ai-token' } }),
    JSON.stringify({ type: 'auth', connection: null }),
    JSON.stringify({ type: 'resource-projects', resourceProjects }),
    JSON.stringify({ type: 'resource-projects', resourceProjects: [] }),
    JSON.stringify({ type: 'user-settings', userSettings: { agent: { permissionPolicy: 'read-only' } } }),
    JSON.stringify({ type: 'close' }),
  ].map(line => `${line}\n`));
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await main(['--host-stdio', '--json', '--no-open'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ accountProtocolVersion: 1, entriesProtocolVersion: 1, systemAiConnectionProtocolVersion: 1, userSettingsProtocolVersion: 1 });
    expect(vi.mocked(startWebServer).mock.calls[0][0].host?.userSettings).toEqual({ agent: { permissionPolicy: 'auto' } });
    expect(vi.mocked(startWebServer).mock.calls[0][0].host?.connection).toEqual({ ...connection, aiServerUrl: systemAiConnection.serverUrl, aiAccessToken: systemAiConnection.accessToken });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(setHostConnection).toHaveBeenNthCalledWith(1, { ...connection, aiServerUrl: systemAiConnection.serverUrl, aiAccessToken: 'rotated-ai-token' });
    expect(setHostConnection).toHaveBeenNthCalledWith(2, undefined);
    expect(setHostResourceProjects).toHaveBeenNthCalledWith(1, resourceProjects);
    expect(setHostResourceProjects).toHaveBeenNthCalledWith(2, []);
    expect(setHostUserSettings).toHaveBeenCalledWith({ agent: { permissionPolicy: 'read-only' } });
  } finally { finish(); await pending; }
});
