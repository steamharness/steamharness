import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const directories = new Set<string>();
/** Test hosts keep persistence outside the project, just like installed hosts. */
export function testDataDirectory(projectDir: string, name = 'data'): string {
  const key = createHash('sha256').update(path.resolve(projectDir)).digest('hex');
  const directory = path.join(os.tmpdir(), 'steamharness-test-hosts', key);
  directories.add(directory);
  return path.join(directory, name);
}
afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
