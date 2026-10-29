export interface FileLinkTarget { path: string; line?: number; column?: number }

/** Interpret model-provided links without resolving them against the Web page URL. */
export function fileLinkTarget(href: string): FileLinkTarget | undefined {
  let path = href.trim();
  if (!path || path.length > 4096 || /[\0-\x1f\x7f]/.test(path) || /^[#?]/.test(path) || path.startsWith('//')) return;
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
}): void {
  if (options.path) {
    for (const code of Array.from(root.querySelectorAll('code'))) {
      if (code.closest('pre, a')) continue;
      const text = code.textContent ?? '';
      if (!looksLikePath(text)) continue;
      const link = document.createElement('a'); link.href = '#'; link.dataset.workflowPath = text;
      code.replaceWith(link); link.append(code);
    }
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
    const target = file ? undefined : fileLinkTarget(link.dataset.workflowPath ?? link.getAttribute('href') ?? '');
    if (file || target && options.path) {
      if (!link.hasAttribute('href')) link.href = '#';
      link.addEventListener('click', event => {
        event.preventDefault();
        const selection = window.getSelection();
        if (event.detail > 0 && selection && !selection.isCollapsed
          && (link.contains(selection.anchorNode) || link.contains(selection.focusNode) || selection.containsNode(link, true))) return;
        if (file) options.file(file); else options.path!(target!);
      });
    } else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  }
}
