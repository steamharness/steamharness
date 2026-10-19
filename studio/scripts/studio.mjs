import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROOT, assertRuntime, assertUpstream, builtinProjectDirectory, exists, git, prepareDistribution, readJSON, resolveMonorepoRoot, run } from './distribution.mjs';
import { buildExtension } from './build-extension.mjs';
import { electronEnvironment, electronVersion, ensureElectronTypes } from './downloads.mjs';
import { ensureDefaultExtensions } from './default-extensions.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [command = 'help', ...args] = process.argv.slice(2);

// macOS caps Unix domain socket paths at 103 characters.
const UNIX_SOCKET_PATH_LIMIT = 103;
// VS Code names its main-process socket `<major.minor>-main.sock`; this leaves
// room for that plus the separating slash.
const SOCKET_NAME_BUDGET = 32;

/**
 * The desktop build opens a Unix domain socket inside the user-data directory,
 * so a deeply nested checkout can push that path past the macOS limit and the
 * launch fails with `listen EINVAL`. Prefer the checkout-local directory and
 * fall back to a short, persistent one under the home directory only when the
 * socket would not fit.
 */
function resolveDesktopUserDataDir(preferred) {
  if (process.platform !== 'darwin') return preferred;
  if (preferred.length + SOCKET_NAME_BUDGET <= UNIX_SOCKET_PATH_LIMIT) return preferred;
  return path.join(os.homedir(), '.studio', 'desktop-user-data');
}

async function prepare() {
  await assertRuntime();
  await buildExtension();
  const result = await prepareDistribution();
  console.log(`Prepared ${result.product.nameLong} on VS Code ${result.upstream.ref}.`);
  return result;
}

async function requireDependencies(upstream) {
  if (!await exists(path.join(upstream.directory, 'node_modules/.postinstall-state'))) {
    throw new Error('VS Code dependencies are missing. Run npm run setup.');
  }
}

async function build(upstream) {
  await requireDependencies(upstream);
  await run(npm, ['run', 'build-fast'], upstream.directory);
}

async function buildReady(upstream) {
  const stateFile = path.join(upstream.directory, '.build/build-fast/state.json');
  if (!await exists(stateFile)) {
    return false;
  }
  const state = await readJSON(stateFile);
  return state.head === upstream.commit &&
    await exists(path.join(upstream.directory, 'out/main.js')) &&
    await exists(path.join(upstream.directory, 'out/server-main.js'));
}

async function launch(upstream, script, launchArgs, environment = {}) {
  const windows = process.platform === 'win32';
  await run(windows ? 'cmd.exe' : 'bash',
    windows ? ['/d', '/c', path.join(upstream.directory, 'scripts', `${script}.bat`), ...launchArgs]
      : [path.join(upstream.directory, 'scripts', `${script}.sh`), ...launchArgs],
    upstream.directory, {
      ...environment,
      VSCODE_SKIP_PRELAUNCH: '1', VSCODE_CWD: ROOT,
      VSCODE_SKIP_BUILTIN_EXTENSIONS: [process.env.VSCODE_SKIP_BUILTIN_EXTENSIONS,
        'vscode.vscode-api-tests', 'GitHub.copilot', 'GitHub.copilot-chat'].filter(Boolean).join(','),
    });
}

const hasFlag = (flag) => args.some((argument) => argument === flag || argument.startsWith(`${flag}=`));

async function doctor() {
  let failed = false;
  const check = async (label, action) => {
    try {
      console.log(`[OK] ${label}: ${await action()}`);
    } catch (error) {
      failed = true;
      console.error(`[MISSING] ${label}: ${error.message}`);
    }
  };
  await check('Node', async () => { await assertRuntime(); return process.versions.node; });
  await check('Git', () => git(['--version'], ROOT));
  await check('VS Code source', async () => {
    const upstream = await assertUpstream();
    return `${upstream.ref} (${upstream.commit.slice(0, 12)})`;
  });
  await check('Studio extension', async () => {
    for (const target of ['extension.js', 'extension-web.js']) {
      if (!await exists(path.join(ROOT, 'extensions/studio-workstation/dist', target))) {
        throw new Error('Run npm run build:extension.');
      }
    }
    return 'desktop + web';
  });
  await check('VS Code dependencies', async () => {
    await requireDependencies(await assertUpstream());
    return 'native modules and built-in extension dependencies installed';
  });
  await check('Workbench output', async () => {
    const upstream = await assertUpstream();
    if (!await buildReady(upstream)) {
      throw new Error('Run npm run build.');
    }
    return 'successful development build for the pinned revision';
  });
  if (process.platform === 'darwin') {
    await check('Xcode toolchain', () => execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim());
  }
  if (failed) {
    process.exitCode = 1;
  }
}

async function main() {
  switch (command) {
    case 'setup': {
      await assertRuntime();
      const lock = await readJSON(path.join(ROOT, 'config/upstream.json'));
      if (!await exists(path.join(ROOT, lock.path, '.git'))) {
        await run('git', ['submodule', 'update', '--init', '--depth', '1', lock.path], ROOT);
      }
      for (const builtin of ['developer-assistant', 'studio-control', 'analysis']) {
        await builtinProjectDirectory(builtin);
      }
      const { upstream } = await prepare();
      const electronEnv = await electronEnvironment(upstream);
      await ensureElectronTypes(upstream, electronEnv);
      const installEnv = {
        npm_config_audit: 'false', npm_config_fund: 'false', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
        // Upstream on-device dictation is optional for the Studio workstation.
        FOUNDRY_LOCAL_SKIP_INSTALL: process.env.FOUNDRY_LOCAL_SKIP_INSTALL ?? '1',
        ...electronEnv,
      };
      await run(npm, ['ci'], upstream.directory, installEnv);
      if (process.platform === 'linux' && process.env.CI === 'true' &&
          process.env.STUDIO_CI_DEFER_POSTINSTALL === '1') {
        await run(process.execPath, ['build/npm/postinstall.ts'], upstream.directory, {
          ...installEnv, STUDIO_CI_DEFER_POSTINSTALL: '', npm_command: 'ci',
        });
      }
      await run(npm, ['run', 'download-builtin-extensions'], upstream.directory);
      console.log('Studio dependencies ready. Next: npm run build');
      break;
    }
    case 'prepare':
      await prepare();
      break;
    case 'electron': {
      const { upstream } = await prepare();
      await requireDependencies(upstream);
      await run(process.execPath, [path.join(ROOT, 'scripts/electron.mjs')], ROOT);
      break;
    }
    case 'build': {
      const { upstream } = await prepare();
      await build(upstream);
      break;
    }
    case 'watch': {
      const { upstream } = await prepare();
      await requireDependencies(upstream);
      await Promise.all([
        run(npm, ['run', 'watch-transpile'], upstream.directory),
        buildExtension({ watch: true }),
      ]);
      break;
    }
    case 'workflow':
    case 'test:desktop':
    case 'dev': {
      const { upstream, product } = await prepare();
      await requireDependencies(upstream);
      if (!await buildReady(upstream)) {
        await build(upstream);
      }
      const executable = process.platform === 'darwin'
        ? path.join(upstream.directory, '.build/electron', `${product.nameLong}.app`, 'Contents/MacOS', product.nameShort)
        : path.join(upstream.directory, '.build/electron', process.platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName);
      const versionFile = path.join(upstream.directory, '.build/electron/version');
      const installedVersion = await exists(versionFile)
        ? (await readFile(versionFile, 'utf8')).trim().replace(/^v/, '') : undefined;
      if (!await exists(executable) || installedVersion !== await electronVersion(upstream) || process.env.VSCODE_FORCE_PRELAUNCH) {
        await run(process.execPath, [path.join(ROOT, 'scripts/electron.mjs')], ROOT);
      }
      await run(process.execPath, ['build/lib/preLaunch.ts'], upstream.directory, {
        ...await electronEnvironment(upstream), VSCODE_FORCE_PRELAUNCH: '',
      });
      const testing = command === 'test:desktop';
      const extensionsDirectory = path.join(ROOT, testing ? '.studio/test-desktop-extensions' : '.studio/desktop-extensions');
      const directoryArgs = [
        '--user-data-dir', resolveDesktopUserDataDir(path.join(ROOT, testing ? `.studio/test-${process.pid}` : '.studio/desktop-user-data')),
        '--extensions-dir', extensionsDirectory,
        '--builtin-extensions-dir', path.join(upstream.directory, 'extensions'),
      ];
      await ensureDefaultExtensions(extensionsDirectory, (vsix) =>
        launch(upstream, 'code-cli', [...directoryArgs, '--install-extension', vsix]));
      const desktopArgs = testing ? [
        `--extensionDevelopmentPath=${path.join(upstream.directory, 'extensions/vscode-api-tests')}`,
        `--extensionTestsPath=${path.join(ROOT, 'tests/extension-host.cjs')}`,
        ...args, ROOT,
      ] : args.length ? args : [command === 'workflow' ? await resolveMonorepoRoot() : ROOT];
      const assistantFixture = testing ? await (await import('../tests/assistant-dependency-fixture.mjs')).createAssistantDependencyFixture() : undefined;
      try {
        await launch(upstream, 'code', [
          ...directoryArgs,
          '--disable-telemetry',
          '--disable-workspace-trust',
          ...desktopArgs,
        ], assistantFixture ? { STUDIO_STEAMHARNESS_SOURCE: assistantFixture.root } : {});
      } finally { await assistantFixture?.dispose(); }
      break;
    }
    case 'workflow:web':
    case 'web': {
      const { upstream } = await prepare();
      await requireDependencies(upstream);
      if (!await buildReady(upstream)) {
        await build(upstream);
      }
      await run(npm, ['run', 'download-builtin-extensions'], upstream.directory);
      const extensionsDirectory = path.join(ROOT, '.studio/web-extensions');
      const defaults = [
        '--server-data-dir', path.join(ROOT, '.studio/web-server-data'),
        '--extensions-dir', extensionsDirectory,
        '--builtin-extensions-dir', path.join(upstream.directory, 'extensions'),
        '--telemetry-level', 'off',
        '--disable-workspace-trust',
      ];
      await ensureDefaultExtensions(extensionsDirectory, (vsix) =>
        launch(upstream, 'code-server', [...defaults, '--install-extension', vsix]));
      if (!hasFlag('--host')) {
        defaults.push('--host', '127.0.0.1');
      }
      if (!hasFlag('--port') && !hasFlag('--socket-path')) {
        defaults.push('--port', '3030-3040');
      }
      if (!hasFlag('--default-folder') && !hasFlag('--default-workspace')) {
        defaults.push('--default-folder', command === 'workflow:web' ? await resolveMonorepoRoot() : ROOT);
      }
      console.log('Studio Web URL and connection token will be printed by the server.');
      await launch(upstream, 'code-server', [...defaults, ...args]);
      break;
    }
    case 'doctor':
      await doctor();
      break;
    case 'help':
      console.log('Studio commands: setup, prepare, electron, build, watch, dev [VS Code arguments], web [server arguments], doctor, test:desktop');
      break;
    default:
      throw new Error(`Unknown Studio command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`Studio: ${error.message}`);
  process.exitCode = 1;
});
