import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const integer = '(?:0|[1-9][0-9]*)';
const identifier = `(?:${integer}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
export const releaseVersion = new RegExp(`^${integer}\\.${integer}\\.${integer}(?:-${identifier}(?:\\.${identifier})*)?$`, 'u');
const componentName = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const sections = [
  ['新特性', 'New Features'], ['破坏性变更', 'Breaking Changes'], ['新增', 'Added'],
  ['变更', 'Changed'], ['修复', 'Fixed'], ['移除', 'Removed'], ['Pi Durable', 'Pi Durable'],
];
const locales = ['', 'en/'];
export const publicNotes = Object.freeze({ directory: 'guides/releases', basePath: '/guides/releases' });

function checkIdentity(component, version) {
  if (!componentName.test(component) || !releaseVersion.test(version)) {
    throw new Error(`Invalid release notes identity: ${component}@${version}`);
  }
}

export function releaseNotePaths(component, version, scope = publicNotes) {
  checkIdentity(component, version);
  const url = `${scope.basePath}/${component}/v${version}/`;
  return { 'zh-CN': url, en: `/en${url}` };
}

export function compareVersions(left, right) {
  const split = (value) => {
    const dash = value.indexOf('-');
    return dash === -1 ? [value, []] : [value.slice(0, dash), value.slice(dash + 1).split('.')];
  };
  const [a, ap] = split(left), [b, bp] = split(right);
  const compare = (first, second) => first > second ? 1 : first < second ? -1 : 0;
  const core = a.split('.').map((part, i) => compare(BigInt(part), BigInt(b.split('.')[i]))).find(Boolean);
  if (core) return core;
  if (!ap.length || !bp.length) return compare(bp.length, ap.length);
  for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue;
    const aNumeric = /^[0-9]+$/u.test(ap[i]), bNumeric = /^[0-9]+$/u.test(bp[i]);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aNumeric ? compare(BigInt(ap[i]), BigInt(bp[i])) : compare(ap[i], bp[i]);
  }
  return compare(ap.length, bp.length);
}

export function parseReleaseNotes(source, file, { version, english = false, draft = false } = {}) {
  const [opening, frontmatter, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source.replace(/\r\n/gu, '\n')) ?? [];
  const fail = (message, line) => { throw new Error(`${file}${line ? `:${line}` : ''}: ${message}`); };
  if (!opening || !/^title: .+/mu.test(frontmatter)) fail('expected MDX frontmatter with a title');
  const draftFields = [...frontmatter.matchAll(/^draft:\s*(.*?)\s*$/gmu)].map(match => match[1]);
  if (draft ? draftFields.join(',') !== 'true' : draftFields.length > 0) {
    fail(draft ? 'unreleased.mdx requires draft: true' : 'a version page must not declare draft');
  }
  if (/^(?:slug|id|unlisted):/mu.test(frontmatter)) fail('release routes must use the file path');
  const heading = /^# (.+)$/mu.exec(body)?.[1];
  const title = /^title: (.+)$/mu.exec(frontmatter)[1].trim().replace(/^(['"])(.*)\1$/u, '$2');
  if (!heading || (!draft && [heading, title].some(text => ![version, `v${version}`].includes(text.split(/\s+/u).at(-1))))) {
    fail(`title and H1 must identify v${version}`);
  }

  const outline = [];
  const ids = new Set();
  let section = -1, archived = '', entry, hasHeading = false;
  const lines = body.split('\n');
  const checkMigration = (line) => {
    if (entry?.breaking && !entry.migration) fail(`breaking entry ${entry.id} needs a migration note`, line);
    entry = undefined;
  };
  for (const [index, line] of lines.entries()) {
    const number = index + frontmatter.split('\n').length + 3;
    if (!line.trim()) continue;
    if (/^# /u.test(line) && !hasHeading) { hasHeading = true; continue; }
    const legacy = /^## (?:历史发布线|Legacy release) \((\d{4}-\d{2}-\d{2})\)$/u.exec(line);
    if (legacy && !draft) {
      checkMigration(number);
      archived = legacy[1];
      section = -1;
      continue;
    }
    const category = /^#{3,4} (.+)$/u.exec(line);
    if (category) {
      checkMigration(number);
      section = sections.findIndex(labels => labels[Number(english)] === category[1]);
      if (section < 0) fail(`unknown release section: ${category[1]}`, number);
      continue;
    }
    if (line.startsWith('- ')) {
      checkMigration(number);
      const item = /^- (\S.*?) \{\/\* note: ([a-z0-9]+(?:-[a-z0-9]+)*) \*\/\}$/u.exec(line);
      if (section < 0 || !item) fail('expected a list item ending with {/* note: stable-id */} under a release section', number);
      const [, , id] = item;
      if (ids.has(id)) fail(`duplicate note ID: ${id}`, number);
      ids.add(id);
      outline.push(`${archived}:${section}:${id}`);
      entry = { id, breaking: section === 1, migration: false };
      continue;
    }
    if (entry?.breaking && !entry.migration && (english ? /^  Migration: \S/u : /^  迁移：\s*\S/u).test(line)) {
      entry.migration = true;
      continue;
    }
    if (entry && /^ {2,}\S/u.test(line)) continue;
    // Retain historical version anchors and release metadata above the first section.
    if (section < 0 && hasHeading && (/^<span id="[^"<>]+"(?: className="release-version-anchor")?><\/span>$/u.test(line) || /^\d{4}-\d{2}-\d{2}(?:\s|$)/u.test(line))) continue;
    if (draft && section < 0 && line === (english ? 'No changes recorded yet.' : '暂无待发布条目。')) continue;
    fail('unexpected release notes content', number);
  }
  checkMigration(lines.length + frontmatter.split('\n').length + 2);
  if (!draft && !outline.length) fail('a version page must contain release notes');
  return outline;
}

export function validateReleasePair(root, component, version, scope = publicNotes) {
  const draft = version === 'unreleased';
  if (draft) {
    if (!componentName.test(component)) throw new Error(`Invalid release component: ${component}`);
  } else checkIdentity(component, version);
  const stem = draft ? version : `v${version}`;
  const outlines = locales.map((locale) => {
    const file = `${locale}${scope.directory}/${component}/${stem}.mdx`;
    if (!existsSync(path.join(root, file))) throw new Error(`Missing release notes: ${file}`);
    return parseReleaseNotes(readFileSync(path.join(root, file), 'utf8'), file, { version, draft, english: Boolean(locale) });
  });
  if (JSON.stringify(outlines[0]) !== JSON.stringify(outlines[1])) {
    const i = outlines[0].findIndex((item, index) => item !== outlines[1][index]);
    throw new Error(`${component}/${stem}: Chinese and English note IDs/sections differ (entry ${i < 0 ? outlines[0].length + 1 : i + 1}).`);
  }
  return draft ? null : releaseNotePaths(component, version, scope);
}

export function releaseCatalog(root, scope = publicNotes) {
  const entries = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
  const directories = locales.map(locale => entries(path.join(root, locale, scope.directory)).filter(entry => entry.isDirectory()).map(entry => entry.name));
  const catalog = new Map();
  for (const component of new Set(directories.flat())) {
    if (!componentName.test(component)) throw new Error(`Invalid release component: ${component}`);
    const names = new Set(locales.flatMap(locale => entries(path.join(root, locale, scope.directory, component)).map(entry => entry.name)));
    const versions = [];
    for (const name of names) {
      if (name === 'unreleased.mdx') continue;
      const version = /^v(.+)\.mdx$/u.exec(name)?.[1];
      if (!version || !releaseVersion.test(version)) throw new Error(`Invalid release file: ${scope.directory}/${component}/${name}`);
      versions.push(version);
    }
    catalog.set(component, versions.sort((a, b) => compareVersions(b, a)));
  }
  return catalog;
}

export function validateReleaseCatalog(root, scope = publicNotes) {
  const catalog = releaseCatalog(root, scope);
  for (const [component, versions] of catalog) {
    validateReleasePair(root, component, 'unreleased', scope);
    for (const version of versions) validateReleasePair(root, component, version, scope);
  }
  return catalog;
}

export function withReleaseNavigation(languages, catalog, scope = publicNotes, { preview = false } = {}) {
  const result = structuredClone(languages);
  for (const language of result) {
    const prefix = language.language === 'en' ? 'en/' : '';
    const pathPrefix = `${prefix}${scope.directory}/`;
    const indexed = new Set();
    for (const tab of language.tabs) for (const group of tab.groups ?? []) for (const item of group.pages ?? []) {
      if (typeof item === 'string' || !item.path.startsWith(pathPrefix)) continue;
      const component = item.path.slice(pathPrefix.length);
      if (!catalog.has(component)) throw new Error(`Missing release notes directory: ${item.path}`);
      if (item.items?.length) throw new Error(`Remove manually listed version pages from ${item.path}`);
      indexed.add(component);
      item.items = [...(preview ? [`${item.path}/unreleased`] : []), ...catalog.get(component).map(version => `${item.path}/v${version}`)];
    }
    for (const component of catalog.keys()) if (!indexed.has(component)) throw new Error(`Add ${pathPrefix}${component} to release navigation`);
  }
  return result;
}

export async function verifyReleaseNoteLinks(baseUrl, docsPaths, { request = fetch } = {}) {
  await Promise.all(Object.values(docsPaths).map(async route => {
    const url = new URL(route, baseUrl);
    const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) {
      throw new Error(`Publish the version documentation first: ${url} (HTTP ${response.status})`);
    }
    const html = await response.text();
    if (!html.includes(`rel="canonical" href="${url.href}"`) && !html.includes(`href="${url.href}" rel="canonical"`)) {
      throw new Error(`Version page has no matching canonical link: ${url}`);
    }
  }));
}
