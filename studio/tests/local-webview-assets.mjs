import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from '../scripts/distribution.mjs';

export async function serveLocalWebviewAssets(context, upstream) {
  // Exercise the local workbench and built assets without the external CDN.
  await context.addInitScript(() => {
    if (location.pathname.endsWith('/webview/browser/pre/index.html')) {
      const url = new URL(location.href);
      url.searchParams.set('disableServiceWorker', 'true');
      history.replaceState(null, '', url);
    }
  });
  await context.route(/https:\/\/[^/]+\.vscode-cdn\.net\/.*\/webview\/browser\/pre\/(?:index\.html|fake\.html|service-worker\.js)(?:\?|$)/, async route => {
    const filename = path.posix.basename(new URL(route.request().url()).pathname);
    await route.fulfill({ path: path.join(upstream.directory, 'out/vs/workbench/contrib/webview/browser/pre', filename),
      contentType: filename.endsWith('.js') ? 'application/javascript' : 'text/html' });
  });
  await context.route(/https:\/\/[^/]+\.vscode-resource\.vscode-cdn\.net\/.*\/extensions\/studio-workstation\/dist\//, async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.split('/extensions/studio-workstation/dist/')[1]);
    const assets = path.join(ROOT, 'extensions/studio-workstation/dist'), filename = path.resolve(assets, relative);
    assert.ok(filename.startsWith(assets + path.sep));
    await route.fulfill({ path: filename, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
}
