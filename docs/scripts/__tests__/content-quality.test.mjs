import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { contentQualityIssues, proseBlocks, renderedInternalLinks, validateImages, validateNavigationCoverage } from '../content-quality.mjs';

test('long prose is counted across soft line breaks, but examples and tables are preserved', () => {
  const prose = `${'界'.repeat(100)}\n${'界'.repeat(81)}`;
  assert.equal(contentQualityIssues('guide.mdx', prose).length, 1);
  assert.equal(contentQualityIssues('guide.mdx', prose.replace('\n', '\n\n')).length, 0);
  for (const source of [`\`\`\`ts\n${prose}\n\`\`\``, `~~~text\n${prose}\n~~~`, `| ${'界'.repeat(300)} |`, `---\ntitle: ${'界'.repeat(300)}\n---`]) {
    assert.equal(contentQualityIssues('guide.mdx', source).length, 0);
  }
});

test('English word limits, list items, and history exemptions are independent', () => {
  assert.equal(contentQualityIssues('en/guide.mdx', 'word '.repeat(101)).length, 1);
  assert.equal(contentQualityIssues('guide.mdx', `- ${'界'.repeat(181)}`).length, 1);
  assert.equal(contentQualityIssues('guide.mdx', `${'界'.repeat(90)}\n\n- ${'界'.repeat(91)}`).length, 0);
  assert.equal(contentQualityIssues('en/guide.mdx', 'word '.repeat(101), { historical: true }).length, 0);
  assert.equal(proseBlocks('# Title\n\nA sentence.\n\n<Note>\nAnother sentence.\n</Note>').length, 2);
});

test('rendered images need alt text; fenced image examples do not', () => {
  assert.equal(contentQualityIssues('guide.mdx', '![](images/run.png)').length, 1);
  assert.equal(contentQualityIssues('guide.mdx', '<img src="/run.png" />').length, 1);
  assert.equal(contentQualityIssues('guide.mdx', '![Run results](images/run.png)').length, 0);
  assert.equal(contentQualityIssues('guide.mdx', '```md\n![](missing.png)\n```').length, 0);
});

test('union types in table cells must not become MDX expressions', () => {
  assert.equal(contentQualityIssues('reference.mdx', '| Type | `{ value: number | null }` |').length, 1);
  assert.equal(contentQualityIssues('reference.mdx', '| Type | `{ value: number \\| null }` |').length, 0);
  assert.equal(contentQualityIssues('reference.mdx', '```md\n| Type | `number | null` |\n```').length, 0);
});

test('rendered page links exclude image assets and code examples', () => {
  const source = '[Guide](/guide)\n![Screenshot](/enhanced/run.png)\n`[Example](/not-a-page)`\n<Card href="/en/guide" />\n```md\n[Fixture](/fixture)\n```';
  assert.deepEqual(renderedInternalLinks(source), ['/guide', '/en/guide']);
});

test('images resolve to real assets and cannot cross the public/private boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docs-images-'));
  try {
    const images = path.join(root, 'images'), privateStatic = path.join(root, 'static');
    await mkdir(images); await mkdir(path.join(privateStatic, 'enhanced'), { recursive: true });
    await writeFile(path.join(images, 'run.png'), 'fixture');
    await writeFile(path.join(privateStatic, 'enhanced', 'model.png'), 'fixture');
    const file = path.join(root, 'guides', 'run.mdx');
    await validateImages({ file, source: '![Run](../images/run.png)', publicImages: images });
    await assert.rejects(validateImages({ file, source: '![Run](../images/missing.png)', publicImages: images }), /missing image/u);
    await assert.rejects(validateImages({ file, source: '![Private](/enhanced/model.png)', publicImages: images }), /public documentation/u);
    await validateImages({ file, source: '![Private](/enhanced/model.png)', publicImages: images, privateStatic });
    await assert.rejects(validateImages({ file, source: '![Outside](../../secret.png)', publicImages: images }), /documentation image directory/u);
    if (process.platform !== 'win32') {
      await symlink(path.join(privateStatic, 'enhanced', 'model.png'), path.join(images, 'linked.png'));
      await assert.rejects(validateImages({ file, source: '![Linked](../images/linked.png)', publicImages: images }), /symlink leaves/u);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('navigation covers every page and preserves bilingual order', () => {
  const language = pages => ({ tabs: [{ groups: [{ pages }] }] });
  const languages = [language(['index', 'guide']), language(['en/index', 'en/guide'])];
  validateNavigationCoverage(languages, ['index.mdx', 'guide.mdx', 'en/index.mdx', 'en/guide.mdx']);
  assert.throws(() => validateNavigationCoverage(languages, ['orphan.mdx']), /missing from navigation/u);
  assert.throws(() => validateNavigationCoverage([languages[0], language(['en/guide', 'en/index'])], []), /same page order/u);
});
