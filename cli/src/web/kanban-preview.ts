import { randomBytes } from 'node:crypto';
import { lstat, realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createKanbanContentSecurityPolicy, encodeKanbanAssetUrlPath, injectKanbanBridge, isSafeKanbanPublicAssetPath, readKanbanAssetMimeType, type KanbanArtifactConfig, type KanbanInjectedConfiguration } from '@workflow-code/kanban-project';

function injectTheme(html: string, nonce: string): string {
  // Editor themes can differ from the OS preference of nested Electron frames.
  const script = `<script nonce=${JSON.stringify(nonce)}>(() => {
    addEventListener('message', event => {
      const message = event.data;
      if (event.source !== parent || message?.nonce !== ${JSON.stringify(nonce)} || message.type !== 'workflow-code:kanban-theme' || !['light', 'dark'].includes(message.theme)) return;
      document.documentElement.dataset.theme = message.theme;
      document.documentElement.style.colorScheme = message.theme;
      dispatchEvent(new CustomEvent('workflow-code:kanban-theme-change', { detail: { theme: message.theme } }));
    });
  })();</script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head || head.index === undefined) { return `${html}${script}`; }
  const index = head.index + head[0].length;
  return `${html.slice(0, index)}${script}${html.slice(index)}`;
}

export class KanbanPreview {
  readonly nonce = randomBytes(24).toString('base64url');
  constructor(private readonly projectRoot: string, readonly artifact: KanbanArtifactConfig, private readonly configuration: () => KanbanInjectedConfiguration) {}
  get url(): string { return `/kanban/${this.nonce}/${encodeKanbanAssetUrlPath(this.artifact.entry)}`; }
  async asset(url: URL): Promise<{ content: Buffer | string; headers: Record<string, string> } | undefined> {
    const prefix = `/kanban/${this.nonce}/`;
    if (!url.pathname.startsWith(prefix)) { return; }
    try {
      const asset = decodeURIComponent(url.pathname.slice(prefix.length));
      if (asset.includes('\\') || !isSafeKanbanPublicAssetPath(asset, this.artifact.entry)) { return; }
      const projectRoot = await realpath(this.projectRoot);
      let artifactRoot = projectRoot;
      if (this.artifact.artifactDir !== '.') {
        for (const segment of this.artifact.artifactDir.split('/')) { artifactRoot = path.join(artifactRoot, segment); if ((await lstat(artifactRoot)).isSymbolicLink()) { return; } }
      }
      let filename = artifactRoot;
      for (const segment of asset.split('/')) { filename = path.join(filename, segment); if ((await lstat(filename)).isSymbolicLink()) { return; } }
      const canonical = await realpath(filename), relative = path.relative(artifactRoot, canonical);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) { return; }
      const info = await stat(canonical);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) { return; }
      const headers = { 'Content-Type': readKanbanAssetMimeType(asset), 'Content-Security-Policy': `${createKanbanContentSecurityPolicy(this.nonce)}; form-action 'none'; frame-ancestors 'self' vscode-webview: vscode-file: https://*.vscode-cdn.net https://*.vscode-webview.net http://127.0.0.1:* http://localhost:*`, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
      return { headers, content: asset === this.artifact.entry ? injectKanbanBridge(injectTheme(await readFile(canonical, 'utf8'), this.nonce), this.configuration(), this.nonce) : await readFile(canonical) };
    } catch { return; }
  }
}
