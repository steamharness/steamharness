import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BotArtifact, BotArtifactStore } from 'steamharness/runtime-storage';

const idPattern = /^\/api\/bot-artifacts\/(ba_[a-f0-9]{32})(\/content)?$/;
const raster = new Map(Object.entries({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }));
const textTypes = new Set(['md', 'txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml']);
const textPreviewLimit = 64 * 1024;
const extension = (name: string) => name.split('.').at(-1)?.toLowerCase() ?? '';
type JsonResponse = (response: ServerResponse, code: number, output: unknown) => void;
export type BotArtifactResult = { status: number; json: unknown }
  | { status: 200; content: { name: string; bytes: Uint8Array; mime: string; preview: boolean; truncated: boolean } };

function publicArtifact(artifact: BotArtifact, hasSource: (artifact: BotArtifact) => boolean) {
  const type = extension(artifact.name);
  return { id: artifact.id, name: artifact.name, title: artifact.title, size: artifact.size, createdAt: artifact.createdAt,
    preview: raster.has(type) ? 'image' : textTypes.has(type) ? 'text' : null,
    ...(hasSource(artifact) ? { conversationId: artifact.source.conversationId } : {}) };
}

/** The caller must bind the store to an authorized project and Bot entry. */
export function readBotArtifactResult(url: URL, method: string | undefined, store: BotArtifactStore | undefined,
  hasSource: (artifact: BotArtifact) => boolean = () => false, imagePreviewLimit = Infinity): BotArtifactResult {
  const error = (status: number, code: string) => ({ status, json: { code } });
  if (!store) return error(404, 'BOT_ARTIFACTS_UNAVAILABLE');
  const match = idPattern.exec(url.pathname);
  if (url.pathname === '/api/bot-artifacts' && method === 'GET') {
    const raw = url.searchParams.get('before');
    const before = raw === null ? undefined : Number(raw);
    if (before !== undefined && (!/^\d+$/u.test(raw!) || !Number.isSafeInteger(before) || before < 1)) return error(400, 'INVALID_CURSOR');
    const page = store.list(before);
    return { status: 200, json: { artifacts: page.artifacts.map(artifact => publicArtifact(artifact, hasSource)), nextBefore: page.nextBefore } };
  }
  if (!match) return error(404, 'BOT_ARTIFACT_NOT_FOUND');
  const id = match[1]!;
  if (!match[2] && method === 'DELETE') {
    // Repeating a confirmed removal is safe and cannot touch the source file.
    store.delete(id);
    return { status: 200, json: { removed: true } };
  }
  if (method !== 'GET') return error(405, 'METHOD_NOT_ALLOWED');
  if (!match[2]) {
    const record = store.get(id);
    return record ? { status: 200, json: publicArtifact(record, hasSource) } : error(404, 'BOT_ARTIFACT_NOT_FOUND');
  }
  const preview = url.searchParams.get('preview') === '1';
  if (preview && Number.isFinite(imagePreviewLimit)) {
    const record = store.get(id);
    if (record && raster.has(extension(record.name)) && record.size > imagePreviewLimit) return error(415, 'BOT_ARTIFACT_PREVIEW_UNAVAILABLE');
  }
  const record = store.read(id);
  if (!record) return error(404, 'BOT_ARTIFACT_NOT_FOUND');
  const type = extension(record.artifact.name);
  if (preview && !raster.has(type) && !textTypes.has(type)) return error(415, 'BOT_ARTIFACT_PREVIEW_UNAVAILABLE');
  const text = preview && textTypes.has(type);
  const bytes = text ? record.bytes.subarray(0, textPreviewLimit) : record.bytes;
  return { status: 200, content: { name: record.artifact.name, bytes, preview, truncated: bytes.length < record.bytes.byteLength,
    mime: preview ? raster.get(type) ?? 'text/plain; charset=utf-8' : 'application/octet-stream' } };
}

/** Invoked only after the project web host authenticates a local Studio request. */
export function respondToBotArtifacts(request: IncomingMessage, response: ServerResponse, url: URL,
  store: BotArtifactStore | undefined, json: JsonResponse, hasSource: (artifact: BotArtifact) => boolean): void {
  const result = readBotArtifactResult(url, request.method, store, hasSource);
  if ('json' in result) { json(response, result.status, result.json); return; }
  const { name, bytes, preview, truncated, mime } = result.content;
  response.writeHead(result.status, { 'Content-Type': mime,
    'Content-Disposition': preview ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    ...(truncated ? { 'X-SteamHarness-Preview-Truncated': '1' } : {}) });
  response.end(bytes);
}
