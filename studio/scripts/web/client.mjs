import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import * as esbuild from 'esbuild';

const workbenchPath = 'vs/code/browser/workbench';
const bundleName = 'workbench.studio-web';
const marker = 'id="vscode-studio-release-entry"';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const brotli = promisify(brotliCompress);
const gzipAsset = promisify(gzip);
const assetTypes = new Map([['.js', 'text/javascript'], ['.css', 'text/css'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'],
  ['.ttf', 'font/ttf'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.sh', 'text/plain']]);

function replaceOne(text, anchor, replacement) {
  assert.equal(text.split(anchor).length, 2, `Expected one ${anchor.slice(0, 90)} in the workbench.`);
  return text.replace(anchor, () => replacement);
}

export function retargetSocket(text, { origin, websocketPort }) {
  const site = new URL(origin);
  assert(site.protocol === 'https:' && site.origin === origin && !site.port && /^[a-z0-9.-]+$/u.test(site.hostname));
  assert(Number.isInteger(websocketPort) && websocketPort >= 1024 && websocketPort <= 65535);
  const statement = `const studioSocketPort = webSocketSchema === 'wss' && mainWindow.location.hostname === '${site.hostname}' && host === '${site.hostname}' && Number(port) === 443 && /^\\/oss-dev\\/?$/.test(path) ? ${websocketPort} : port;`;
  if (text.includes('const studioSocketPort')) {
    assert(text.includes(statement), 'A different Workbench relay is already installed.');
    assert(text.includes('${studioSocketPort}${path}?${query}&skipWebSocketFrames=false'));
    return text;
  }
  const anchor = 'const socket = this._webSocketFactory.create(`${webSocketSchema}://';
  return replaceOne(replaceOne(text, anchor, `${statement}\n      ${anchor}`), '${port}${path}?${query}&skipWebSocketFrames=false',
    '${studioSocketPort}${path}?${query}&skipWebSocketFrames=false');
}

export function renderWebClientTemplate(template, { script, styles }) {
  const prefix = `{{WORKBENCH_WEB_BASE_URL}}/out/${workbenchPath}`;
  const entry = `<script type="module" src="${prefix}/workbench.js"></script>`;
  const hook = `<script nonce="{{WORKBENCH_SCRIPT_NONCE}}">
    addEventListener('error', event => {
      if (event.target?.id === 'vscode-studio-release-entry') document.getElementById('vscode-startup-fallback')?.setAttribute('data-state', 'failed');
    }, true);
  </script>`;
  let updated = replaceOne(template, entry, `${hook}\n<script type="module" ${marker} src="${prefix}/${script}"></script>`);
  updated = replaceOne(updated, '</head>', `<link rel="modulepreload" href="${prefix}/${script}">\n<link rel="stylesheet" href="${prefix}/${styles}">\n</head>`);
  updated = replaceOne(updated, 'animation: vscode-startup-fallback-reveal 0s linear 10s forwards;', 'visibility: visible;');
  const opening = '<div id="vscode-startup-fallback">';
  const start = updated.indexOf(opening);
  const end = updated.indexOf('</div>', start);
  assert(start >= 0 && end > start, 'The built loading fallback has changed.');
  const status = `<style>
  #vscode-startup-fallback .studio-cn, #vscode-startup-fallback .studio-failed { display: none; }
  #vscode-startup-fallback:lang(zh-cn) .studio-en, #vscode-startup-fallback[data-state=failed] .studio-loading { display: none; }
  #vscode-startup-fallback:lang(zh-cn):not([data-state=failed]) .studio-cn.studio-loading,
  #vscode-startup-fallback[data-state=failed]:not(:lang(zh-cn)) .studio-en.studio-failed,
  #vscode-startup-fallback[data-state=failed]:lang(zh-cn) .studio-cn.studio-failed { display: block; }
</style>
<div id="vscode-startup-fallback" role="status" lang="{{WORKBENCH_STUDIO_LANGUAGE}}">
  <h1 class="studio-loading studio-en">Loading the workbench&hellip;</h1>
  <h1 class="studio-loading studio-cn">&#27491;&#22312;&#21152;&#36733;&#24037;&#20316;&#21488;&hellip;</h1>
  <h1 class="studio-failed studio-en">The workbench could not load</h1>
  <h1 class="studio-failed studio-cn">&#24037;&#20316;&#21488;&#21152;&#36733;&#22833;&#36133;</h1>\n`;
  return updated.slice(0, start) + status + updated.slice(end);
}

async function loadClient(directory) {
  const template = path.join(directory, 'workbench.html');
  const manifest = JSON.parse(await readFile(path.join(directory, 'assets.json'), 'utf8'));
  const assets = new Map();
  for (const { name, digest, compressed } of manifest) {
    const mime = assetTypes.get(path.extname(name));
    assert(mime && /^(?:studio-web-assets\/)?[\w.-]+$/u.test(name) && /^[a-f0-9]{64}$/u.test(digest));
    const file = path.join(directory, name);
    const variants = {};
    for (const [encoding, suffix] of compressed ? [['identity', ''], ['br', '.br'], ['gzip', '.gz']] : [['identity', '']]) {
      const info = await stat(file + suffix);
      assert(info.isFile());
      variants[encoding] = { file: file + suffix, size: info.size };
    }
    assets.set(name, { mime, etag: `W/"${digest}"`, variants });
  }
  const html = await readFile(template, 'utf8');
  assert(html.includes(marker) && [...assets.keys()].filter(name => name.startsWith(bundleName + '-')).length === 2);
  return { template, assets };
}

/** Build once per managed data directory. Each running gateway owns its own template and assets. */
export async function prepareWebClient(kernel, cache, transport = {}) {
  const outputDirectory = path.join(kernel, 'out', workbenchPath);
  const factory = path.join(kernel, 'out/vs/platform/remote/browser/browserSocketFactory.js');
  const [template, state, recipe] = await Promise.all([
    readFile(path.join(kernel, 'src', workbenchPath, 'workbench-dev.html'), 'utf8'),
    readFile(path.join(kernel, '.build/build-fast/state.json'), 'utf8').catch(() => randomUUID()),
    readFile(new URL(import.meta.url)),
  ]);
  const fingerprint = hash(JSON.stringify([hash(recipe), hash(template), state, esbuild.version, transport]));
  const prepared = path.join(cache, fingerprint);
  const cached = await loadClient(prepared).catch(() => undefined);
  if (cached) return cached;

  const build = await esbuild.build({
    absWorkingDir: kernel,
    entryPoints: [{ in: path.join(outputDirectory, 'workbench.js'), out: bundleName }], outdir: outputDirectory,
    bundle: true, format: 'esm', platform: 'neutral', packages: 'external', target: 'es2024', minify: true,
    metafile: true, write: false, loader: { '.ttf': 'file', '.svg': 'file', '.png': 'file', '.sh': 'file', '.woff': 'file', '.woff2': 'file' },
    assetNames: 'studio-web-assets/[name]-[hash]',
    plugins: transport.websocketPort === undefined ? [] : [{ name: 'studio-web-relay', setup(context) {
      context.onLoad({ filter: /browserSocketFactory\.js$/ }, async ({ path: file }) => {
        if (path.relative(factory, file) === '') return { contents: retargetSocket(await readFile(file, 'utf8'), transport), resolveDir: path.dirname(file) };
      });
    } }],
  });
  assert(!Object.values(build.metafile.outputs).filter(file => file.entryPoint).some(file =>
    file.imports.some(item => item.external && item.kind === 'import-statement')), 'The bundled startup module has an unresolved import.');

  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(path.join(cache, 'build-'));
  try {
    const manifest = [];
    const entry = {};
    for (const output of build.outputFiles) {
      const digest = hash(output.contents);
      const suffix = path.extname(output.path);
      let name = path.relative(outputDirectory, output.path).split(path.sep).join('/');
      const compressed = name === bundleName + '.js' || name === bundleName + '.css';
      if (compressed) {
        name = `${bundleName}-${digest.slice(0, 32)}${suffix}`;
        entry[suffix === '.js' ? 'script' : 'styles'] = name;
      }
      const dest = path.join(staging, name);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, output.contents);
      if (compressed) {
        await writeFile(dest + '.br', await brotli(output.contents, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: output.contents.byteLength },
        }));
        await writeFile(dest + '.gz', await gzipAsset(output.contents));
      }
      manifest.push({ name, digest, compressed });
    }
    assert(entry.script && entry.styles, 'The Studio Web bundle is missing its script or stylesheet.');
    await writeFile(path.join(staging, 'workbench.html'), renderWebClientTemplate(template, entry));
    await writeFile(path.join(staging, 'assets.json'), JSON.stringify(manifest));
    await rm(prepared, { recursive: true, force: true });
    await rename(staging, prepared);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const result = await loadClient(prepared);
  // This cache belongs to the data-directory owner lock, so older generations have no live readers.
  for (const name of await readdir(cache)) {
    if (name !== fingerprint && /^(?:[a-f0-9]{64}|build-[a-zA-Z0-9]{6})$/u.test(name)) {
      await rm(path.join(cache, name), { recursive: true, force: true });
    }
  }
  console.log(`Prepared compressed Studio Web client from ${Object.keys(build.metafile.inputs).length} source assets.`);
  return result;
}
