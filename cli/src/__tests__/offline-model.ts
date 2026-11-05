import { once } from 'node:events';
import { createServer } from 'node:http';
import { getUserSettings } from 'steamharness';

/** Deterministic local transport for tests of generated Core Bot projects. */
export async function offlineModel(text: string | ((request: any) => string) = 'Local reply') {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const answer = typeof text === "function" ? text(body) : text;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: object, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'fixture',
      choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    response.end(chunk({ role: 'assistant', content: answer }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const settings = getUserSettings();
  return {
    settings: { ...settings, agent: { ...settings.agent, model: 'fixture', models: [{
      id: 'fixture', name: 'Offline model', source: 'third-party' as const,
      apiKind: 'openai-completions' as const, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      apiKey: 'offline-fixture', model: 'fixture',
    }] } },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}
