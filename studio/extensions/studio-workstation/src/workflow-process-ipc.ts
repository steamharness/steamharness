import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import type { Socket } from 'node:net';
import path from 'node:path';

export const processProtocol = 1;
export const maxFrame = 4 * 1024 * 1024;
export interface ProcessLaunch {
  key: string;
  command: string;
  args: string[];
  directory: string;
  env: NodeJS.ProcessEnv;
  entryId: string;
  projectId?: string;
  sources: string[];
  activityRoots: string[];
  controlUnavailable?: string;
}
export interface ProcessEndpoint { version: number; port: number; secret: string }

export async function processDirectory(data: string, create: boolean): Promise<string> {
  if (create) await mkdir(data, { recursive: true, mode: 0o700 });
  const directory = path.join(await realpath(data), '.studio-processes');
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))) {
    throw new Error('Invalid Studio project process directory.');
  }
  return directory;
}

export const proof = (secret: string, role: 'client' | 'server', nonce: string) => createHmac('sha256', secret).update(`${role}:${nonce}`).digest('hex');
export const isNonce = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const matches = (value: unknown, expected: string) => isNonce(value) && timingSafeEqual(Buffer.from(value), Buffer.from(expected));

export function send(socket: Socket, value: object): boolean {
  if (socket.destroyed || !socket.writable) return false;
  const frame = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(frame) > maxFrame || socket.writableLength > maxFrame) { socket.destroy(); return false; }
  socket.write(frame);
  return true;
}

export function readFrames(socket: Socket, receive: (value: Record<string, any>) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    try {
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > maxFrame) throw new Error('Oversized Studio project process message.');
        const value = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Studio project process message.');
        receive(value);
        if (socket.destroyed) return;
      }
      if (buffer.length > maxFrame) socket.destroy();
    } catch { socket.destroy(); }
  });
}

export function overlaps(left: string, right: string): boolean {
  const contains = (root: string, value: string) => {
    const relative = path.relative(root, value);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  return contains(left, right) || contains(right, left);
}
