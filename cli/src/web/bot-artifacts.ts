import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BotArtifact, BotArtifactStore } from 'steamharness/runtime-storage';

const idPattern = /^\/api\/bot-artifacts\/(ba_[a-f0-9]{32})(\/content)?$/;
const raster = new Map(Object.entries({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }));
const textTypes = new Set(['md', 'txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml']);
const textPreviewLimit = 64 * 1024;
const extension = (name: string) => name.split('.').at(-1)?.toLowerCase() ?? '';
type JsonResponse = (response: ServerResponse, code: number, output: unknown) => void;

function publicArtifact(artifact: BotArtifact, hasSource: (artifact: BotArtifact) => boolean) {
  const type = extension(artifact.name);
  return { id: artifact.id, name: artifact.name, title: artifact.title, size: artifact.size, createdAt: artifact.createdAt,
    preview: raster.has(type) ? 'image' : textTypes.has(type) ? 'text' : null,
    ...(hasSource(artifact) ? { conversationId: artifact.source.conversationId } : {}) };
}

/** Invoked only after the project web host authenticates a local Studio request. */
export function respondToBotArtifacts(request: IncomingMessage, response: ServerResponse, url: URL,
  store: BotArtifactStore | undefined, json: JsonResponse, hasSource: (artifact: BotArtifact) => boolean): void {
  if (!store) { json(response, 404, { code: 'BOT_ARTIFACTS_UNAVAILABLE' }); return; }
  const match = idPattern.exec(url.pathname);
  if (url.pathname === '/api/bot-artifacts' && request.method === 'GET') {
    const raw = url.searchParams.get('before');
    const before = raw === null ? undefined : Number(raw);
    if (before !== undefined && (!/^\d+$/u.test(raw!) || !Number.isSafeInteger(before) || before < 1)) { json(response, 400, { code: 'INVALID_CURSOR' }); return; }
    const page = store.list(before);
    json(response, 200, { artifacts: page.artifacts.map(artifact => publicArtifact(artifact, hasSource)), nextBefore: page.nextBefore });
    return;
  }
  if (!match) { json(response, 404, { code: 'BOT_ARTIFACT_NOT_FOUND' }); return; }
  const id = match[1]!;
  if (!match[2] && request.method === 'DELETE') {
    // Repeating a confirmed removal is safe and cannot touch the source file.
    store.delete(id);
    json(response, 200, { removed: true });
    return;
  }
  if (request.method !== 'GET') { json(response, 405, { code: 'METHOD_NOT_ALLOWED' }); return; }
  if (!match[2]) {
    const record = store.get(id);
    if (record) json(response, 200, publicArtifact(record, hasSource));
    else json(response, 404, { code: 'BOT_ARTIFACT_NOT_FOUND' });
    return;
  }
  const record = store.read(id);
  if (!record) { json(response, 404, { code: 'BOT_ARTIFACT_NOT_FOUND' }); return; }
  const preview = url.searchParams.get('preview') === '1';
  const type = extension(record.artifact.name);
  if (preview && !raster.has(type) && !textTypes.has(type)) { json(response, 415, { code: 'BOT_ARTIFACT_PREVIEW_UNAVAILABLE' }); return; }
  const text = preview && textTypes.has(type);
  const body = Buffer.from(record.bytes.buffer, record.bytes.byteOffset, text ? Math.min(textPreviewLimit, record.bytes.byteLength) : record.bytes.byteLength);
  response.writeHead(200, { 'Content-Type': preview ? raster.get(type) ?? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'Content-Disposition': preview ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(record.artifact.name).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    ...(text && body.length < record.bytes.byteLength ? { 'X-SteamHarness-Preview-Truncated': '1' } : {}) });
  response.end(body);
}
