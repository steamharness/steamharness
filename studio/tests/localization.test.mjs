import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { register } from 'tsx/esm/api';
import ts from 'typescript';

register();
const { configureLocalization, t, locale } = await import('../extensions/studio-workstation/src/localization.ts');
const { workflowInfoItems } = await import('../extensions/studio-workstation/src/workflow-info.ts');
const { traceRows } = await import('../extensions/studio-workstation/webview/trace-model.ts');
const json = async path => JSON.parse(await readFile(new URL(`../extensions/studio-workstation/${path}`, import.meta.url), 'utf8'));
const english = await json('l10n/bundle.l10n.json'), chinese = await json('l10n/bundle.l10n.zh-cn.json');
afterEach(() => configureLocalization({}, 'en'));

test('English and Chinese catalogs cover the same messages and preserve every placeholder', async () => {
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
  const placeholders = text => [...text.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();
  for (const key of Object.keys(english)) {
    assert.deepEqual(placeholders(chinese[key]), placeholders(english[key]), key);
  }
  for (const folder of ['src', 'webview']) {
    const names = await readdir(new URL(`../extensions/studio-workstation/${folder}/`, import.meta.url), { recursive: true });
    for (const name of names.filter(name => name.endsWith('.ts'))) {
      const source = await readFile(new URL(`../extensions/studio-workstation/${folder}/${name}`, import.meta.url), 'utf8');
      const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
      const visit = node => {
        if (ts.isCallExpression(node) && (node.expression.getText(ast) === 't' || node.expression.getText(ast) === 'vscode.l10n.t')
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          assert.ok(Object.hasOwn(english, node.arguments[0].text), `${name}: ${node.arguments[0].text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
  }
});

test('every translated contribution resolves in English and Chinese', async () => {
  const manifest = await json('package.json'), en = await json('package.nls.json'), zh = await json('package.nls.zh-cn.json');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.ok(Object.values(en).every(value => !/\p{Script=Han}/u.test(value)), 'English contribution labels must not contain hardcoded Chinese');
  for (const match of JSON.stringify(manifest.contributes).matchAll(/%([^%]+)%/g)) {
    assert.ok(en[match[1]], match[1]); assert.ok(zh[match[1]], match[1]);
  }
  assert.equal(en['command.openWorkflow'], 'Run Project');
  assert.equal(zh['command.openWorkflow'], '\u8fd0\u884c\u9879\u76ee');
});

for (const language of ['en', 'zh-cn']) {
  test(`${language} localizes information and traces while preserving project values and execution content`, () => {
    configureLocalization(language === 'en' ? {} : chinese, language);
    const project = { id: 'project-id', name: '\u6211\u7684\u9879\u76ee', projectType: 'workflow', folderPath: '/project', entrypoints: [] };
    const items = workflowInfoItems(project, { description: '\u539f\u59cb\u63cf\u8ff0', workflowCode: { projectInfo: {
      declarations: ['multilingual'], localizedNames: { en: 'My project', 'zh-CN': '\u6211\u7684\u9879\u76ee' }, dataStorage: { mode: 'both' },
    } } });
    assert.equal(items[0].label, language === 'en' ? 'Basic Information' : '\u57fa\u672c\u4fe1\u606f');
    assert.equal(items[0].children[0].value, project.name);
    assert.equal(items[0].children.find(item => item.id === 'type').value, language === 'en' ? 'Workflow' : '\u5de5\u4f5c\u6d41');
    assert.equal(items[0].children.find(item => item.id === 'description').value, '\u539f\u59cb\u63cf\u8ff0');
    assert.equal(items[1].children[0].label, language === 'en' ? 'Multiple languages' : '\u652f\u6301\u591a\u8bed\u8a00');
    assert.equal(items[4].children[0].value, language === 'en' ? 'Local and server' : '\u672c\u5730\u548c\u670d\u52a1\u5668');
    const rows = traceRows({ project, run: { id: 'run-id', title: '\u5b9e\u9645\u8fd0\u884c', status: 'success', logs: '\u539f\u59cb\u65e5\u5fd7',
      items: [{ id: 'output', content: '\u539f\u59cb\u7ed3\u679c' }] } }, {});
    assert.equal(rows.find(row => row.lane === 'log').title, language === 'en' ? 'Run logs' : '\u8fd0\u884c\u65e5\u5fd7');
    assert.equal(rows.find(row => row.lane === 'log').preview, '\u539f\u59cb\u65e5\u5fd7');
    assert.equal(rows.find(row => row.lane === 'output').preview, '\u539f\u59cb\u7ed3\u679c');
    assert.equal(t('Delete "{0}"?', 'item {1}'), language === 'en' ? 'Delete "item {1}"?' : '\u5220\u9664\u201citem {1}\u201d\uff1f');
    assert.equal(locale(), language === 'en' ? 'en' : 'zh-CN');
  });
}
