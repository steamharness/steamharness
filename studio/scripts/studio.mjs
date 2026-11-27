import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROOT, assertRuntime, assertUpstream, builtinProjectDirectory, exists, git, prepareDistribution, readJSON, resolveMonorepoRoot, run } from './distribution.mjs';
import { buildExtension } from './build-extension.mjs';
import { builtinProjectCompiler } from './builtin-project-release.mjs';
import { electronEnvironment, electronVersion, ensureElectronTypes } from './downloads.mjs';
import { devElectronIsSigned } from './electron-cache.mjs';
import { ensureDefaultExtensions } from './default-extensions.mjs';
import { desktopWebControl, runManagedWeb, webBuiltins, workspaceArgs } from './web/launcher.mjs';
import { webConfig } from './web/config.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [command = 'help', ...args] = process.argv.slice(2);

const productHome = path.join(os.homedir(), '.steamharness');

async function prepare(options) {
  await assertRuntime();
  await buildExtension();
  const result = await prepareDistribution(ROOT, options);
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

async function hasWorkbenchOutput(upstream) {
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
const flagValue = flag => {
  const index = args.findIndex(argument => argument === flag || argument.startsWith(`${flag}=`));
  return index < 0 ? undefined : args[index] === flag ? args[index + 1] : args[index].slice(flag.length + 1);
};
const webDirectory = () => {
  return path.join(productHome, 'hosts', 'web');
};

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
  await check('Workbench output files', async () => {
    const upstream = await assertUpstream();
    if (!await hasWorkbenchOutput(upstream)) {
      throw new Error('Run npm run build.');
    }
    return 'development output exists for the pinned revision; startup checks source changes with build-fast';
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
      const assistantSource = await builtinProjectDirectory('developer-assistant');
      await builtinProjectDirectory('analysis');
      if (!await builtinProjectCompiler(assistantSource).catch(() => undefined)) {
        const monorepo = await resolveMonorepoRoot();
        const pnpm = spawnSync('pnpm', ['--version'], { cwd: monorepo, shell: process.platform === 'win32', stdio: 'ignore' }).status === 0;
        const tool = pnpm ? 'pnpm' : 'corepack';
        const invoke = (args) => run(tool, pnpm ? args : ['pnpm', ...args], monorepo);
        await invoke(['install', '--frozen-lockfile']);
        await invoke(['run', 'build']);
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
      // Patches and local edits can change source without changing HEAD.
      // Let build-fast validate its own input fingerprints on every launch.
      await build(upstream);
      const cache = path.join(upstream.directory, '.build/electron');
      const macBundle = process.platform === 'darwin' ? path.join(cache, `${product.nameLong}.app`) : undefined;
      const executable = macBundle
        ? path.join(macBundle, 'Contents/MacOS', product.nameShort)
        : path.join(cache, process.platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName);
      const versionFile = path.join(cache, 'version');
      const installedVersion = await exists(versionFile)
        ? (await readFile(versionFile, 'utf8')).trim().replace(/^v/, '') : undefined;
      if (!await exists(executable) || installedVersion !== await electronVersion(upstream) || process.env.VSCODE_FORCE_PRELAUNCH ||
          (macBundle && !await devElectronIsSigned(upstream, macBundle))) {
        await run(process.execPath, [path.join(ROOT, 'scripts/electron.mjs')], ROOT);
      }
      await run(process.execPath, ['build/lib/preLaunch.ts'], upstream.directory, {
        ...await electronEnvironment(upstream), VSCODE_FORCE_PRELAUNCH: '',
      });
      const testing = command === 'test:desktop';
      if (!testing && hasFlag('--user-data-dir')) throw new Error('SteamHarness stores desktop data under ~/.steamharness/hosts.');
      const testHome = testing ? path.join(os.tmpdir(), `studio-test-${process.pid}`) : undefined;
      const testEnv = testHome ? { HOME: testHome, USERPROFILE: testHome } : {};
      const extensionsDirectory = testing ? path.join(ROOT, '.studio/test-desktop-extensions') : path.join(productHome, 'studio', 'extensions');
      const directoryArgs = [
        '--extensions-dir', extensionsDirectory,
        '--builtin-extensions-dir', path.join(upstream.directory, 'extensions'),
      ];
      await ensureDefaultExtensions(extensionsDirectory, (extension) =>
        launch(upstream, 'code-cli', [...directoryArgs, '--install-extension', extension], testEnv));
      const desktopArgs = testing ? [
        `--extensionDevelopmentPath=${path.join(upstream.directory, 'extensions/vscode-api-tests')}`,
        `--extensionTestsPath=${path.join(ROOT, 'tests/extension-host.cjs')}`,
        ...args, ROOT,
      ] : command === 'workflow' && !args.length ? [await resolveMonorepoRoot()] : args;
      const assistantFixture = testing ? await (await import('../tests/assistant-dependency-fixture.mjs')).createAssistantDependencyFixture(
        (await readJSON(path.join(ROOT, 'extensions/studio-workstation/dist/developer-assistant/project/package.json'))).devDependencies) : undefined;
      const remote = testing ? undefined : await desktopWebControl({ directory: webDirectory() });
      try {
        await launch(upstream, 'code', [
          ...directoryArgs,
          '--disable-telemetry',
          ...(testing || product.workspaceTrustEnabledByDefault === undefined ? ['--disable-workspace-trust'] : []),
          ...desktopArgs,
        ], { ...remote?.env, ...testEnv, ...(assistantFixture ? { STUDIO_STEAMHARNESS_SOURCE: assistantFixture.root } : {}) });
      } finally { await remote?.close(); await assistantFixture?.dispose(); }
      break;
    }
    case 'workflow:web':
    case 'web': {
      const { port, serverArgs, bundleClient } = workspaceArgs(args);
      if (command === 'workflow:web' && !hasFlag('--default-folder') && !hasFlag('--default-workspace')) {
        serverArgs.push(`--default-folder=${await resolveMonorepoRoot()}`);
      }
      const directory = webDirectory();
      const config = await webConfig(process.env, port);
      await runManagedWeb({ directory, config, prepare: async () => {
        const { upstream, extensionSource } = await prepare({ linkBuiltinExtension: false });
        await requireDependencies(upstream);
        await build(upstream);
        await run(npm, ['run', 'download-builtin-extensions'], upstream.directory);
        const extensionsDirectory = path.join(productHome, 'studio', 'extensions');
        const defaults = ['--server-data-dir', directory, '--extensions-dir', extensionsDirectory,
          '--builtin-extensions-dir', await webBuiltins(directory, upstream.directory, extensionSource), '--telemetry-level', 'off', '--disable-workspace-trust'];
        await ensureDefaultExtensions(extensionsDirectory, extension => run(process.execPath,
          [path.join(upstream.directory, 'out/server-main.js'), ...defaults, '--install-extension', extension],
          upstream.directory, { NODE_ENV: 'development', VSCODE_DEV: '1' }));
        return { upstream: upstream.directory, args: [...defaults, ...serverArgs], bundleClient };
      } });
      break;
    }
    case 'doctor':
      await doctor();
      break;
    case 'help':
      console.log('Studio commands: setup, prepare, electron, build, watch, dev [VS Code arguments], web [--port port] [--unbundled] [--default-folder path | --default-workspace path], doctor, test:desktop');
      break;
    default:
      throw new Error(`Unknown Studio command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`Studio: ${error.message}`);
  process.exitCode = 1;
});
