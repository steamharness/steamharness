import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('the native project details renderer and stylesheet are generated from the shared source', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/sync-project-details.mjs', import.meta.url))], { stdio: 'inherit' });
});
