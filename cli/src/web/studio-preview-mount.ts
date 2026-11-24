import type { IncomingMessage } from 'node:http';

// Studio's gateway strips any client version of this header. This is routing
// metadata, not an authentication mechanism for the local CLI server.
export function studioPreviewMount(request: IncomingMessage): string {
  const value = request.headers['x-steamharness-preview-mount'];
  return typeof value === 'string' && /^\/p\/[\w-]{43}$/.test(value) ? value : '';
}
