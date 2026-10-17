import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveMonorepoRoot } from '../scripts/distribution.mjs';
import { setTimeout as pause } from 'node:timers/promises';

export async function waitForDesktopReady(file, child, timeout = process.env.CI ? 300_000 : 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Studio exited before its test extensions were ready.');
    }
    let state;
    try { state = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    if (state?.error) { throw new Error(`Studio test extension activation failed: ${state.error}`); }
    if (state?.ready) { return; }
    await pause(250);
  }
  throw new Error(`Studio test extension activation timed out after ${timeout}ms.`);
}

export async function desktopLocaleLaunch(language, directory, { sourceMode = false } = {}) {
  const root = fileURLToPath(new URL('../upstream/vscode/', import.meta.url));
  const product = JSON.parse(readFileSync(path.join(root, 'product.json'), 'utf8'));
  const executable = process.platform === 'darwin' ? path.join(root, '.build/electron', `${product.nameLong}.app`, 'Contents/MacOS', product.nameShort)
    : path.join(root, '.build/electron', process.platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName);
  const source = fileURLToPath(new URL('../extensions/studio-workstation/', import.meta.url));
  const extension = path.join(directory, 'extensions', 'studio-workstation');
  await mkdir(extension, { recursive: true });
  await symlink(fileURLToPath(new URL('../vendor/', import.meta.url)), path.join(directory, 'vendor'), process.platform === 'win32' ? 'junction' : 'dir');
  await copyFile(path.join(source, 'package.json'), path.join(extension, 'package.json'));
  // The source-mode scanner always selects package.nls.json. Use the requested
  // contribution catalog in an isolated extension with the real built code.
  await copyFile(path.join(source, language.startsWith('zh') ? 'package.nls.zh-cn.json' : 'package.nls.json'), path.join(extension, 'package.nls.json'));
  // VS Code identifies an extension's API caller by its physical entrypoint.
  await cp(path.join(source, 'dist'), path.join(extension, 'dist'), { recursive: true });
  for (const name of ['resources', 'l10n']) {
    await symlink(path.join(source, name), path.join(extension, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const readiness = path.join(directory, 'test-readiness');
  const readyFile = path.join(readiness, 'ready.json');
  await mkdir(readiness, { recursive: true });
  await rm(readyFile, { force: true });
  await copyFile(fileURLToPath(new URL('./desktop-readiness-extension.cjs', import.meta.url)), path.join(readiness, 'extension.cjs'));
  await writeFile(path.join(readiness, 'package.json'), JSON.stringify({
    name: 'desktop-readiness', publisher: 'studio-test', version: '0.0.1',
    engines: { vscode: '^1.140.0' }, main: './extension.cjs', activationEvents: ['onStartupFinished'],
  }));
  return {
    executable,
    args: [sourceMode ? root : fileURLToPath(new URL('./desktop-localization-bootstrap.cjs', import.meta.url)),
      ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []),
      '--extensionDevelopmentPath', extension, '--extensionDevelopmentPath', readiness],
    waitUntilReady: child => waitForDesktopReady(readyFile, child),
    env: { STUDIO_TEST_UI_LANGUAGE: sourceMode ? '' : language, STUDIO_TEST_VSCODE_ROOT: root,
      STUDIO_STEAMHARNESS_SOURCE: await resolveMonorepoRoot(fileURLToPath(new URL("../", import.meta.url))),
      NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1', ELECTRON_ENABLE_LOGGING: '1' },
  };
}
