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
  const setHostRelatedProjects = vi.fn();
  const relatedProjects = [{ alias: 'database', projectDir: path.join(os.tmpdir(), 'database') }];
  vi.mocked(startWebServer).mockResolvedValue({
    url: `http://127.0.0.1:3000/#session=${'a'.repeat(64)}`,
    project: { id: 'host-test', name: 'Host test', projectType: 'conversation', runtime: { harnessVersion: 'test', harnessPath: 'test' } },
    setHostConnection, setHostRelatedProjects, close,
  } as unknown as Awaited<ReturnType<typeof startWebServer>>);
  const input = Readable.from([
    JSON.stringify({ type: 'configure', surface: 'editor', connection: null }),
    JSON.stringify({ type: 'auth', connection: { serverUrl: 'https://workflow.test', accessToken: 'host-test-token' } }),
    JSON.stringify({ type: 'auth', connection: null }),
    JSON.stringify({ type: 'related-projects', relatedProjects }),
    JSON.stringify({ type: 'related-projects', relatedProjects: [] }),
    JSON.stringify({ type: 'close' }),
  ].map(line => `${line}\n`));
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await main(['--host-stdio', '--json', '--no-open'])).toBe(0);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ accountProtocolVersion: 1, relatedProjectsProtocolVersion: 1 });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(setHostConnection).toHaveBeenNthCalledWith(1, { serverUrl: 'https://workflow.test', accessToken: 'host-test-token' });
    expect(setHostConnection).toHaveBeenNthCalledWith(2, undefined);
    expect(setHostRelatedProjects).toHaveBeenNthCalledWith(1, relatedProjects);
    expect(setHostRelatedProjects).toHaveBeenNthCalledWith(2, []);
  } finally { finish(); await pending; }
});
