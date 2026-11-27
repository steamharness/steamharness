import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { WEB_HOST_ENV } from '../web/runtime';
import { startEntryWebServer } from '../web/server';

it('runs the built-in Assistant and reads both an original and a browser upload through Core', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'assistant-attachment-runtime-')));
  const projectDir = path.resolve(import.meta.dirname, '../../../build-in/build-in-developer-assistant');
  const workdir = path.join(directory, 'workspace');
  const original = path.join(workdir, 'original.txt');
  const markers = ['original-attachment-proof-197', 'browser-attachment-proof-482'];
  const turns: { role: string; content?: unknown }[][] = [];
  let app: Awaited<ReturnType<typeof startEntryWebServer>> | undefined;
  let uploadedPath: string | undefined;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks).toString());
    turns.push(messages);
    const read = messages.some((message: { role: string }) => message.role === 'tool');
    const delta = read ? { role: 'assistant', content: 'Both attachments read.' } : { role: 'assistant',
      tool_calls: [original, uploadedPath].map((file, index) => ({ index, id: `call_read_${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } })) };
    const frame = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: 'attachment-read', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frame(delta, null) + frame({}, read ? 'stop' : 'tool_calls') + 'data: [DONE]\n\n');
  });
  try {
    await mkdir(workdir); await writeFile(original, markers[0]);
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const port = (upstream.address() as { port: number }).port;
    vi.stubEnv(WEB_HOST_ENV, 'studio');
    vi.stubEnv('STEAMHARNESS_DEVELOPER_ASSISTANT_CODE_MODE', 'false');
    app = await startEntryWebServer({ projectDir, dataDir: path.join(directory, 'data'), entryId: 'main', host: {
      surface: 'assistant', assistantProjectDir: projectDir,
      assistant: { standalone: true, workdir, roots: [{ uri: pathToFileURL(workdir).href, folderPath: workdir, name: 'Attachment proof' }] },
      userSettings: { agent: { permissionPolicy: 'workspace', models: [{ id: 'attachment-reader', name: 'Attachment reader', source: 'third-party',
        apiKind: 'openai-completions', model: 'attachment-reader', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'loopback-test-key' }] } },
    } });
    const post = async (message: object) => {
      const token = new URLSearchParams(new URL(app!.url).hash.slice(1)).get('session');
      const response = await fetch(`${app!.origin}/api/message`, { method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(message) });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result.messages[0];
    };
    const local = (await post({ type: 'resolve-paths', paths: [pathToFileURL(original).href] })).references[0];
    expect(local).toMatchObject({ path: original, kind: 'file' });
    const uploaded = (await post({ type: 'import-drop', entries: [{ name: 'browser.txt', kind: 'file', data: Buffer.from(markers[1]).toString('base64') }] })).references[0];
    uploadedPath = uploaded.path;
    expect(uploaded.source).toBe('workspace-upload');
    expect(path.dirname(path.dirname(uploaded.path))).toBe(path.join(workdir, '.steamharness', 'conversation-uploads'));
    await post({ type: 'send', text: 'Read both attachment samples.', params: {}, references: [local, uploaded], attachments: [] });
    await expect.poll(() => app!.controller!.current.messages.at(-1), { timeout: 20_000 }).toMatchObject({ status: 'success', content: 'Both attachments read.' });
    const prompt = turns[0].filter(message => message.role === 'user').map(({ content }) => typeof content === 'string' ? content
      : Array.isArray(content) ? content.map(part => part.text ?? '').join('\n') : '').join('\n');
    expect(prompt).toContain(JSON.stringify([
      { kind: 'file', path: original, source: 'local-reference' }, { kind: 'file', path: uploadedPath, source: 'workspace-upload' },
    ], null, 2));
    const results = turns.at(-1)?.filter(message => message.role === 'tool').map(message => JSON.stringify(message.content)).join('\n');
    for (const marker of markers) expect(results).toContain(marker);
    expect(await readFile(original, 'utf8')).toBe(markers[0]);
  } finally {
    await app?.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
