import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const digest = (content) => createHash('sha256').update(content).digest('hex');

export async function ensureExtensionVsix(root, extension) {
  const vsix = path.join(root, '.studio', `${extension.id}-${extension.version}.vsix`);
  try {
    if (digest(await fs.readFile(vsix)) === extension.sha256) return vsix;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const response = await fetch(extension.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`Extension ${extension.id} download returned HTTP ${response.status}.`);
  }
  const contents = new Uint8Array(await response.arrayBuffer());
  if (digest(contents) !== extension.sha256) {
    throw new Error(`Extension ${extension.id} does not match the pinned SHA-256.`);
  }
  await fs.mkdir(path.dirname(vsix), { recursive: true });
  await fs.writeFile(vsix, contents);
  return vsix;
}
