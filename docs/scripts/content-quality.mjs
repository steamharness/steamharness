import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Read prose blocks without treating code, frontmatter, or tables as paragraphs. */
export function proseBlocks(source) {
  const lines = source.replace(/\r\n/gu, '\n').split('\n');
  const blocks = [];
  let frontmatter = lines[0] === '---', fence, buffer = [], start = 0;
  const flush = () => {
    if (buffer.length) blocks.push({ line: start, text: buffer.join(' ').trim() });
    buffer = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (frontmatter) {
      if (index > 0 && line === '---') frontmatter = false;
      continue;
    }
    const delimiter = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (delimiter?.[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
      continue;
    }
    if (delimiter) { flush(); fence = delimiter; continue; }
    if (!line.trim() || /^\s*(?:#{1,6}\s|\||<[/!A-Za-z]|!\[|[-*_]{3,}\s*$)/u.test(line)) { flush(); continue; }
    if (/^\s*(?:[-*+] |\d+[.)] )/u.test(line)) flush();
    if (!buffer.length) start = index + 1;
    buffer.push(line.replace(/^\s*(?:[-*+] |\d+[.)] |>[ ]?)/u, ''));
  }
  flush();
  return blocks;
}

export function readableText(source) {
  return source.replace(/`[^`]*`/gu, 'CODE')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]*>/gu, '').replace(/https?:\/\/\S+/gu, 'URL');
}

export function contentQualityIssues(relativeFile, source, { historical = false } = {}) {
  if (historical) return [];
  const issues = [];
  const english = relativeFile.startsWith('en/');
  const rendered = source.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[^\n]*/gu, '\n');
  for (const line of rendered.split('\n').filter(line => /^\s*\|/u.test(line))) {
    for (const code of line.matchAll(/`([^`]+)`/gu)) {
      if (/(?<!\\)\|/u.test(code[1])) issues.push(`${relativeFile}: escape union pipes inside table code with \\| to preserve MDX cells.`);
    }
  }
  for (const block of proseBlocks(source)) {
    const text = readableText(block.text);
    const count = english ? (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length
      : (text.match(/\p{Script=Han}/gu) ?? []).length;
    const limit = english ? 100 : 180;
    if (count > limit) issues.push(`${relativeFile}:${block.line}: paragraph has ${count} ${english ? 'words' : 'Chinese characters'} (limit ${limit}); split it by task or meaning.`);
  }
  for (const image of markdownImages(source)) {
    if (!image.alt.trim()) issues.push(`${relativeFile}: image requires descriptive alternative text: ${image.src}`);
  }
  return issues;
}

export function markdownImages(source) {
  // Fenced examples are documentation, not assets rendered on this page.
  const prose = source.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[^\n]*/gu, '\n');
  const images = [...prose.matchAll(/!\[([^\]]*)\]\(<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\)/gu)]
    .map(match => ({ alt: match[1], src: match[2] }));
  for (const match of prose.matchAll(/<img\b([^>]+)>/gu)) {
    const src = /\bsrc=["']([^"']+)["']/u.exec(match[1])?.[1];
    if (src) images.push({ src, alt: /\balt=["']([^"']*)["']/u.exec(match[1])?.[1] ?? '' });
  }
  return images;
}

export function renderedInternalLinks(source) {
  const prose = source
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[^\n]*/gu, '\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/`[^`]*`/gu, '');
  return [...prose.matchAll(/(?:\]\(|href=["'])(\/[^)"'\s]+)(?:\)|["'])/gu)].map(match => match[1]);
}

export async function validateImages({ file, source, publicImages, privateStatic }) {
  for (const { src } of markdownImages(source)) {
    if (/^(?:https?:|data:)/u.test(src)) continue;
    const clean = decodeURIComponent(src.split(/[?#]/u, 1)[0]);
    let target;
    if (clean.startsWith('/enhanced/')) {
      if (!privateStatic) throw new Error(`${file}: public documentation cannot include enhanced images: ${src}`);
      target = path.join(privateStatic, clean);
    } else if (clean.startsWith('/')) {
      target = path.join(publicImages, clean.replace(/^\/images\//u, '/'));
    } else {
      target = path.resolve(path.dirname(file), clean);
    }
    const roots = [publicImages, privateStatic].filter(Boolean).map(root => path.resolve(root));
    if (!roots.some(root => target.startsWith(`${root}${path.sep}`))) {
      throw new Error(`${file}: image must live in a documentation image directory: ${src}`);
    }
    if (!await stat(target).then(value => value.isFile(), () => false)) {
      throw new Error(`${file}: missing image: ${src}`);
    }
    const actual = await realpath(target);
    const actualRoots = await Promise.all(roots.map(root => realpath(root).catch(() => root)));
    if (!actualRoots.some(root => actual.startsWith(`${root}${path.sep}`))) {
      throw new Error(`${file}: image symlink leaves its documentation image directory: ${src}`);
    }
  }
}

export function navigationPageIds(language) {
  return language.tabs.flatMap(tab => (tab.groups ?? []).flatMap(group => group.pages ?? []))
    .flatMap(item => typeof item === 'string' ? [item] : [item.path, ...(item.items ?? [])]);
}

export function validateNavigationCoverage(languages, pages) {
  const normalize = page => page.replace(/^en\//u, '');
  const zh = navigationPageIds(languages[0]);
  const en = navigationPageIds(languages[1]);
  if (JSON.stringify(zh) !== JSON.stringify(en.map(normalize))) {
    throw new Error('Chinese and English navigation must have the same page order and coverage.');
  }
  if (en.some(page => !page.startsWith('en/'))) throw new Error('English navigation must use en/ page IDs.');
  const registered = new Set([...zh, ...en]);
  const missing = pages.filter(page => !registered.has(page.replace(/\.mdx$/u, '')));
  if (missing.length) throw new Error(`Pages missing from navigation: ${missing.join(', ')}`);
}
