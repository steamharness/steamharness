import { checkoutServiceChannel } from '../../shared/service-urls/node.mjs';
import { studioProtocols } from '../../shared/server-auth/index.ts';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatches } from './patches.mjs';
import { ensureExtensionVsix } from './extension-artifacts.mjs';
import { stageOverlayExtension } from './extension-overlay.mjs';

export { applyPatches };

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** 内置项目在 monorepo 中的位置；Studio 不再把它们作为子模块检出。 */
export const BUILTIN_PROJECTS = Object.freeze({
  'developer-assistant': 'build-in/build-in-developer-assistant',
  analysis: 'build-in/build-in-analysis',
});

export async function resolveMonorepoRoot(root = ROOT, env = process.env) {
  if (env.STUDIO_STEAMHARNESS_SOURCE) return path.resolve(env.STUDIO_STEAMHARNESS_SOURCE);
  const monorepo = path.resolve(root, '..');
  if (await exists(path.join(monorepo, 'harness/package.json')) &&
      await exists(path.join(monorepo, 'cli/package.json'))) {
    return monorepo;
  }
  throw new Error(
    'SteamHarness monorepo source is missing. Studio reads harness/ and cli/ from the sibling directories of this '
    + 'repository, so studio/ has to be checked out inside the monorepo. Set STUDIO_STEAMHARNESS_SOURCE to point at '
    + 'the monorepo root when the layout differs.',
  );
}

export async function builtinProjectDirectory(name, root = ROOT) {
  const relative = BUILTIN_PROJECTS[name];
  if (!relative) throw new Error(`Unknown built-in project: ${name}`);
  const directory = path.join(await resolveMonorepoRoot(root), relative);
  if (!await exists(path.join(directory, 'package.json'))) {
    throw new Error(
      `Built-in project ${name} is missing at ${relative}. Check out the SteamHarness monorepo next to this repository.`,
    );
  }
  return directory;
}

export async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function git(args, cwd, env = {}) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * `npm --prefix <dir> run <script>` exports npm_config_prefix into the child
 * environment. nvm refuses to initialise when that value points outside
 * $NVM_DIR, so every terminal the app spawns would start without node.
 */
export function buildChildEnv(env = {}) {
  const merged = { ...process.env, ...env };
  delete merged.npm_config_prefix;
  delete merged.NPM_CONFIG_PREFIX;
  return merged;
}

export function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildChildEnv(env),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    const stop = (signal) => child.kill(signal);
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${signal ?? code}.`));
      }
    });
  });
}

export async function assertRuntime(root = ROOT) {
  const required = (await fs.readFile(path.join(root, '.nvmrc'), 'utf8')).trim();
  const expected = required.split('.').map(Number);
  const actual = process.versions.node.split('.').map(Number);
  if (actual[0] !== expected[0] || actual[1] < expected[1] ||
      (actual[1] === expected[1] && actual[2] < expected[2])) {
    throw new Error(`Node ${required}+ (${expected[0]}.x) required; found ${process.versions.node}. Run: nvm install && nvm use`);
  }
}

/**
 * 内核检出的 HEAD 就是唯一依据：子模块 gitlink 固定源码，config/upstream.json
 * 只记录路径与上游版本号。这里不再比对提交，本地推进内核后无需同步任何锁文件。
 */
export async function assertUpstream(root = ROOT) {
  const lock = await readJSON(path.join(root, 'config/upstream.json'));
  const directory = path.resolve(root, lock.path);
  if (!await exists(path.join(directory, '.git'))) {
    throw new Error('VS Code source is missing. Run npm run setup.');
  }
  return { ...lock, commit: git(['rev-parse', 'HEAD'], directory), directory };
}

const digest = (content) => createHash('sha256').update(content).digest('hex');

export function mergeProduct(base, overrides) {
  const product = { ...base, ...overrides };
  for (const name of ['nameShort', 'nameLong', 'applicationName', 'dataFolderName', 'urlProtocol']) {
    if (typeof product[name] !== 'string' || !product[name].trim()) {
      throw new Error(`Product field ${name} must be a nonempty string.`);
    }
  }
  return product;
}

/** Each installed channel owns its protocol, data directory and operating-system identity. */
export function channelProductIdentity(channel, branding = {}) {
  if (!["dev", "main"].includes(channel)) throw new Error("Invalid Studio channel.");
  const suffix = channel === "main" ? "" : `-${channel}`;
  const baseLabel = branding.nameShort || "SteamHarness";
  const label = channel === "main" ? baseLabel : `${baseLabel} Dev`;
  const identity = {
    nameShort: label, nameLong: label, urlProtocol: studioProtocols[channel],
    dataFolderName: '.steamharness/studio', sharedDataFolderName: '.steamharness/studio/shared',
    darwinBundleIdentifier: `space.yuhe.studio${suffix}`, linuxDesktopName: `space.yuhe.SteamHarness${suffix}`,
    linuxIconName: `steamharness-studio${suffix}`, applicationName: `steamharness-studio${suffix}`,
    serverApplicationName: `steamharness-studio-server${suffix}`, serverDataFolderName: '.steamharness/hosts/web',
    tunnelApplicationName: `steamharness-studio-tunnel${suffix}`,
    win32MutexName: `steamharness-studio${suffix}`, win32AppUserModelId: `Yuhe.Studio${suffix}`,
    win32DirName: label, win32NameVersion: label, win32RegValueName: label, win32ShellNameShort: label,
    win32TunnelServiceMutex: `steamharness-studio-tunnelservice${suffix}`, win32TunnelMutex: `steamharness-studio-tunnel${suffix}`,
  };
  if (channel !== "main") {
    for (const field of ["win32x64AppId", "win32arm64AppId", "win32x64UserAppId", "win32arm64UserAppId"]) {
      const hash = createHash("sha256").update(`steamharness-studio:${channel}:${field}`).digest("hex").slice(0, 32);
      identity[field] = `{{${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}}`;
    }
  }
  return identity;
}

// Edition manifests augment the extension without editing its source checkout.
export function mergeExtensionManifest(base, overlay) {
  const original = base.contributes;
  const added = overlay.contributes ?? {};
  const appendItems = (left, right = {}) => ({ ...left, ...Object.fromEntries(Object.entries(right).map(([key, items]) => [key, [...(left[key] ?? []), ...items]])) });
  return { ...base, activationEvents: [...base.activationEvents, ...(overlay.activationEvents ?? [])], contributes: {
    ...original, commands: [...original.commands, ...(added.commands ?? [])],
    menus: appendItems(original.menus, added.menus), views: appendItems(original.views, added.views),
    viewsContainers: appendItems(original.viewsContainers, added.viewsContainers),
    configuration: { ...original.configuration, properties: { ...original.configuration.properties, ...added.configuration?.properties } },
  } };
}

export async function prepareDistribution(root = ROOT, { linkBuiltinExtension = true } = {}) {
  const upstream = await assertUpstream(root);
  const productFile = path.join(upstream.directory, 'product.json');
  const stateFile = path.join(root, '.studio/product-state.json');
  const base = git(['show', `${upstream.commit}:product.json`], upstream.directory);
  const current = (await fs.readFile(productFile, 'utf8')).trim();
  const overrides = await readJSON(path.join(root, 'config/product.json'));
  const channel = checkoutServiceChannel({root});
  const identity = channelProductIdentity(channel, overrides);
  const product = mergeProduct(JSON.parse(base), {...overrides,...identity});
  const trustedDomainsFile = process.env.STEAMHARNESS_STUDIO_TRUSTED_DOMAINS_FILE;
  if (trustedDomainsFile) {
    const domains = await readJSON(trustedDomainsFile);
    if (!Array.isArray(domains) || domains.some(domain => typeof domain !== 'string' || !/^https:\/\/(?:\*\.)?[\w-]+(?:\.[\w-]+)+$/u.test(domain))) {
      throw new Error('Studio trusted domains must be an array of HTTPS domains (optionally with a leading subdomain wildcard).');
    }
    product.linkProtectionTrustedDomains = [...new Set([...(product.linkProtectionTrustedDomains ?? []), ...domains])];
  }
  if (process.env.STEAMHARNESS_STUDIO_DISABLE_WORKSPACE_TRUST_BY_DEFAULT === '1') {
    product.workspaceTrustEnabledByDefault = false;
  }
  const defaultsFile = path.join(root, 'config/default-extensions.json');
  const bundled = await exists(defaultsFile) ? (await readJSON(defaultsFile)).filter(extension => extension.builtin) : [];
  if (bundled.length) {
    const ids = new Set(bundled.map(extension => extension.id.toLowerCase()));
    product.builtInExtensions = (product.builtInExtensions ?? []).filter(extension => !ids.has(extension.name.toLowerCase()));
    for (const extension of bundled) {
      const vsix = await ensureExtensionVsix(root, extension);
      product.builtInExtensions.push({ name: extension.id, version: extension.version, sha256: extension.sha256,
        vsix: path.relative(upstream.directory, vsix).replaceAll('\\', '/'),
        ...(extension.preserveVsixContents === true ? { preserveVsixContents: true } : {}) });
    }
  }
  const generated = JSON.stringify(product, null, 2);
  const state = await exists(stateFile) ? await readJSON(stateFile) : undefined;
  const packageJSON = JSON.parse(git(['show', `${upstream.commit}:package.json`], upstream.directory));
  const webOverridesFile = path.join(upstream.directory, 'product.overrides.json');
  const webProduct = { ...product, version: packageJSON.version };
  delete webProduct.workspaceTrustEnabledByDefault;
  const webGenerated = JSON.stringify(webProduct, null, 2);
  const webCurrent = await exists(webOverridesFile) ? (await fs.readFile(webOverridesFile, 'utf8')).trim() : undefined;

  if (current !== base && current !== generated && digest(current) !== state?.sha256) {
    throw new Error('upstream/vscode/product.json has local edits. Move your branding changes to config/product.json before preparing Studio.');
  }
  if (webCurrent !== undefined && webCurrent !== webGenerated && digest(webCurrent) !== state?.webSha256) {
    throw new Error('upstream/vscode/product.overrides.json has local edits. Move your branding changes to config/product.json before preparing Studio.');
  }

  const source = path.join(root, 'extensions/studio-workstation');
  const privateStage = path.join(root, '.studio/extension-with-overlay');
  const overlay = process.env.STEAMHARNESS_STUDIO_INTERNAL === '1' ? process.env.STEAMHARNESS_STUDIO_MANIFEST_OVERLAY : undefined;
  const targetSource = overlay ? privateStage : source;
  const link = path.join(upstream.directory, 'extensions/studio-workstation');
  let linked = false;
  let linkExists = false;
  try {
    await fs.lstat(link);
    linkExists = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  if (linkExists) {
    let target;
    try {
      target = await fs.realpath(link);
    } catch {
      throw new Error('The upstream Studio extension link is broken and is not managed by this project.');
    }
    const known = await Promise.all([source, privateStage].map(directory => fs.realpath(directory).catch(() => undefined)));
    if (!known.includes(target)) {
      throw new Error('The upstream Studio extension directory already exists and is not managed by this project.');
    }
    linked = target === await fs.realpath(targetSource).catch(() => undefined);
  }

  if (!await exists(path.join(source, 'dist/extension.js')) ||
      !await exists(path.join(source, 'dist/extension-web.js'))) {
    throw new Error('Studio extension is not built. Run npm run build:extension.');
  }

  await applyPatches(root, upstream.directory);
  if (overlay) {
    await stageOverlayExtension(source, privateStage);
    const manifest = mergeExtensionManifest(await readJSON(path.join(source, 'package.json')), await readJSON(overlay));
    await fs.writeFile(path.join(privateStage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  if (current !== generated) {
    await fs.writeFile(productFile, `${generated}\n`);
  }
  if (webCurrent !== webGenerated) {
    await fs.writeFile(webOverridesFile, `${webGenerated}\n`);
  }
  if (linkBuiltinExtension && !linked) {
    if (linkExists) await fs.unlink(link);
    await fs.symlink(process.platform === 'win32' ? targetSource : path.relative(path.dirname(link), targetSource), link,
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  await fs.writeFile(stateFile, `${JSON.stringify({ commit: upstream.commit, sha256: digest(generated), webSha256: digest(webGenerated) }, null, 2)}\n`);
  return { upstream, product, extensionSource: targetSource };
}
