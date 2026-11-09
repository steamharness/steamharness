export interface FileLinkTarget { path: string; line?: number; column?: number }

// Bare filenames remain editor references. Ambiguous website names can use an
// explicit scheme; www-prefixed names are always treated as website addresses.
const fileExtensions = new Set(('ts tsx js jsx mjs cjs json jsonc md mdx txt rst adoc yaml yml toml ini env config conf properties lock log py rs go sh bash zsh ps1 bat cmd '
  + 'c cc cpp h hpp cs java kt swift rb php vue svelte html htm css scss sass less xml sql csv tsv '
  + 'svg png jpg jpeg gif webp pdf doc docx xls xlsx ppt pptx zip tar gz bz2 7z mp3 mp4 mov mkv wav sqlite db wasm ipynb rmd exe dll dmg pkg apk ipa msi jar class obj lib bin dat har').split(' '));

/** Recognize website references before filename heuristics, without using the page origin. */
export function webLinkTarget(href: string): string | undefined {
  const value = href.trim();
  if (!value || value.length > 4096 || /[\0-\x1f\x7f]/.test(value)) return;
  const explicit = /^https?:\/\//i.test(value), relative = value.startsWith('//');
  let local = false;
  if (!explicit && !relative) {
    const authority = value.split(/[/?#]/, 1)[0];
    local = /^(?:localhost:\d+|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?|\[[\da-f:]+\](?::\d+)?)$/i.test(authority);
    if (!local) {
      if (!/^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}][\p{L}\p{N}-]{1,62}(?::\d+)?$/u.test(authority)) return;
      const extension = authority.replace(/:\d+$/, '').split('.').at(-1)!.toLowerCase();
      if (!/^www\./i.test(authority) && fileExtensions.has(extension)) return;
    }
  }
  try {
    const url = new URL(explicit ? value : relative ? `https:${value}` : `${local ? 'http' : 'https'}://${value}`);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch { /* Invalid website addresses are not browser targets. */ }
  return;
}

/** Interpret model-provided links without resolving them against the Web page URL. */
export function fileLinkTarget(href: string): FileLinkTarget | undefined {
  let path = href.trim();
  if (!path || path.length > 4096 || /[\0-\x1f\x7f]/.test(path) || /^[#?]/.test(path) || path.startsWith('//') || webLinkTarget(path)) return;
  const drive = /^[a-z]:[\\/]/i.test(path);
  const scheme = !drive && /^[a-z][a-z\d+.-]*:/i.test(path) && !/^file:\/\//i.test(path);
  const position = path.match(/#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i) ?? path.match(/:(\d+)(?::(\d+))?$/);
  let line: number | undefined, column: number | undefined;
  if (position) {
    line = Number(position[1]); column = position[2] === undefined ? undefined : Number(position[2]);
    if (!Number.isSafeInteger(line) || line < 1 || column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return;
    path = path.slice(0, position.index);
  }
  // A filename followed by a line number (main.ts:12) also resembles a URI scheme.
  if (scheme && !(position && /^[^:]+\.[a-z\d]+$/i.test(path))) return;
  try {
    if (/^file:\/\//i.test(path)) {
      const url = new URL(path);
      if (url.search || url.hash || url.username || url.password || url.port) return;
      path = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== 'localhost') path = `\\\\${url.hostname}${path.replaceAll('/', '\\')}`;
      else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } else {
      // Fragments and query strings belong to Web navigation, not local filenames.
      if (/[?#]/.test(path)) return;
      path = decodeURIComponent(path);
    }
  } catch { return; }
  if (!path || /[\0-\x1f\x7f]/.test(path) || path.startsWith('//') || !/^[a-z]:[\\/]/i.test(path) && /^[a-z][a-z\d+.-]*:/i.test(path)) return;
  return { path, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}

function looksLikePath(text: string): boolean {
  const target = fileLinkTarget(text);
  if (!target) return false;
  const { path } = target;
  return /^(?:\/|[a-z]:[\\/]|\\\\|\.{1,2}[\\/])/i.test(path)
    || /^(?:[^\s<>:"|?*]+[\\/])+[^\s<>:"|?*]+\.[a-z][a-z\d]*$/i.test(path)
    || /^\.?[\p{L}\p{N}_@-][\p{L}\p{N}_.@ -]*\.[a-z][a-z\d]*$/iu.test(path)
    || /^\.[a-z][\w.-]*$/i.test(path);
}

export function bindOutputFileLinks(root: HTMLElement, options: {
  file(id: string): void;
  path?: (target: FileLinkTarget) => void;
  browser?: (url: string) => void;
}): void {
  for (const code of Array.from(root.querySelectorAll('code'))) {
    if (code.closest('pre, a')) continue;
    const text = code.textContent ?? '', url = webLinkTarget(text);
    if (!url && (!options.path || !looksLikePath(text))) continue;
    const link = document.createElement('a'); link.href = url ?? '#';
    if (!url) link.dataset.workflowPath = text;
    code.replaceWith(link); link.append(code);
  }
  if (options.path) {
    // Plain absolute paths are common in final answers. Leave prose and code blocks intact.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.parentElement?.closest('a, pre, code')) texts.push(node);
    }
    for (const node of texts) {
      const pattern = /(^|[\s:：(（])((?:file:\/\/|[a-z]:[\\/]|\\\\|\/)[^\s<>"'`，。；！？（）]+)/gi;
      const fragment = document.createDocumentFragment(); let end = 0;
      for (const match of node.data.matchAll(pattern)) {
        const path = match[2].replace(/[.,;!?)\]}]+$/, '');
        if (!fileLinkTarget(path)) continue;
        const start = match.index! + match[1].length;
        fragment.append(node.data.slice(end, start));
        const link = document.createElement('a'); link.href = '#'; link.dataset.workflowPath = path; link.textContent = path;
        fragment.append(link); end = start + path.length;
      }
      if (end) { fragment.append(node.data.slice(end)); node.replaceWith(fragment); }
    }
  }
  for (const link of Array.from(root.querySelectorAll('a'))) {
    const file = link.dataset.workflowFile;
    const value = link.dataset.workflowPath ?? link.getAttribute('href') ?? '';
    const url = file ? undefined : webLinkTarget(value);
    const target = file || url ? undefined : fileLinkTarget(value);
    if (url) { link.href = url; delete link.dataset.workflowPath; }
    if (url || !file && !(target && options.path)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    const open = file ? () => options.file(file) : url && options.browser ? () => options.browser!(url)
      : target && options.path ? () => options.path!(target) : undefined;
    if (open) {
      if (!link.hasAttribute('href')) link.href = '#';
      const activate = (event: MouseEvent) => {
        event.preventDefault();
        const selection = window.getSelection();
        if (event.detail > 0 && selection && !selection.isCollapsed
          && (link.contains(selection.anchorNode) || link.contains(selection.focusNode) || selection.containsNode(link, true))) return;
        open();
      };
      link.addEventListener('click', activate);
      if (url) link.addEventListener('auxclick', event => { if (event.button === 1) activate(event); });
    }
  }
}
