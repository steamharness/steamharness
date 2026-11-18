import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateReleaseCatalog, validateReleasePair, verifyReleaseNoteLinks, withReleaseNavigation } from '../release-notes.mjs';
import { validateDocs } from '../validate-docs.mjs';
import { writeReleaseFixture } from './release-fixture.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-notes-lint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const navigation = { languages: ['zh-Hans', 'en'].map((language, i) => ({ language, tabs: [{ groups: [{ pages: [{ path: `${i ? 'en/' : ''}guides/releases/core` }] }] }] })) };
  await writeFile(path.join(root, 'docs.json'), JSON.stringify({ navigation }));
  await writeReleaseFixture(root, 'core', 'unreleased');
  for (const prefix of ['', 'en/']) {
    await writeFile(path.join(root, prefix, 'guides/releases/core.mdx'), '---\ntitle: Core\n---\n\n# Core\n\n{/* release-versions */}\n');
    await mkdir(path.join(root, prefix, 'openapi'));
    await writeFile(path.join(root, prefix, 'openapi/steamharness.openapi.yaml'), 'openapi: 3.0.0\npaths:\n');
  }
  return { root, navigation };
}

test('version lists come from paired pages; drafts only enter preview navigation', async t => {
  const { root, navigation } = await fixture(t);
  for (const version of ['1.2.0', '1.10.0', '1.10.0-alpha.2', '1.10.0-alpha.10']) await writeReleaseFixture(root, 'core', version);
  const catalog = validateReleaseCatalog(root);
  const production = withReleaseNavigation(navigation.languages, catalog);
  const preview = withReleaseNavigation(navigation.languages, catalog, undefined, { preview: true });
  const items = language => language.tabs[0].groups[0].pages[0].items;
  assert.deepEqual(items(production[0]), ['1.10.0', '1.10.0-alpha.10', '1.10.0-alpha.2', '1.2.0'].map(version => `guides/releases/core/v${version}`));
  assert.equal(items(preview[1])[0], 'en/guides/releases/core/unreleased');
  assert.equal(items(navigation.languages[1]), undefined);
});

test('lint rejects missing translations, mismatched IDs, bad versions, and missing migration steps', async t => {
  const { root } = await fixture(t);
  const [zh, en] = await writeReleaseFixture(root, 'core', '1.2.0', { enId: 'misaligned' });
  assert.throws(() => validateReleasePair(root, 'core', '1.2.0'), /note IDs\/sections differ/u);
  await rm(en);
  assert.throws(() => validateReleasePair(root, 'core', '1.2.0'), /Missing release notes: en\//u);
  await writeReleaseFixture(root, 'core', '1.2.0');
  const source = await readFile(zh, 'utf8');
  await writeFile(zh, source.replaceAll('v1.2.0', 'v1.1.0'));
  assert.throws(() => validateReleasePair(root, 'core', '1.2.0'), /title and H1/u);
  await writeFile(zh, source.replace('#### 修复', '#### 破坏性变更'));
  assert.throws(() => validateReleasePair(root, 'core', '1.2.0'), /needs a migration note/u);
  await writeFile(zh, source.replace('#### 修复', '#### 破坏性变更') + '  迁移：更新调用方式。\n');
  await writeFile(en, (await readFile(en, 'utf8')).replace('#### Fixed', '#### Breaking Changes') + '  Migration: Update the call site.\n');
  assert.deepEqual(validateReleasePair(root, 'core', '1.2.0'), { 'zh-CN': '/guides/releases/core/v1.2.0/', en: '/en/guides/releases/core/v1.2.0/' });
});

test('standalone lint checks links in release notes', async t => {
  const { root } = await fixture(t);
  const [zh] = await writeReleaseFixture(root, 'core', '1.2.0');
  await validateDocs({ root });
  await writeFile(zh, (await readFile(zh, 'utf8')).replace('修复了发布问题。', '详见[升级说明](/guides/nonexistent)。'));
  await assert.rejects(validateDocs({ root }), /unresolved internal link: \/guides\/nonexistent/u);
});

test('release preflight rejects an HTTP 200 fallback with the wrong canonical page', async () => {
  const docsPaths = { 'zh-CN': '/guides/releases/core/v1.2.0/', en: '/en/guides/releases/core/v1.2.0/' };
  const base = 'https://docs.example.test';
  const page = href => new Response(`<link rel="canonical" href="${href}">`, { headers: { 'content-type': 'text/html' } });
  await verifyReleaseNoteLinks(base, docsPaths, { request: async url => page(url.href) });
  await assert.rejects(verifyReleaseNoteLinks(base, docsPaths, { request: async () => page(`${base}/`) }), /no matching canonical/u);
  await assert.rejects(verifyReleaseNoteLinks(base, docsPaths, { request: async () => new Response(null, { status: 404 }) }), /Publish the version documentation first/u);
});
