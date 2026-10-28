import { writeProjectFixture } from '../../scripts/test-project-fixture.mjs';
import { afterEach, expect, it } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { t } from '../web/localization';
import { agentActivity } from '../web/ui/agent-activity';
import chinese from '../web/messages.zh-cn.json';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWebRuntime } from '../web/runtime';

afterEach(() => initI18n({ preference: 'zh-CN' }));

it.each(['en', 'zh-CN'] as const)('renders %s controls and activities without translating execution content', language => {
  initI18n({ preference: language });
  expect(t('Trace')).toBe(language === 'en' ? 'Trace' : '\u8f68\u8ff9');
  expect(t('Commands')).toBe(language === 'en' ? 'Commands' : '\u547d\u4ee4');
  expect(t('Search conversations')).toBe(language === 'en' ? 'Search conversations' : '\u641c\u7d22\u5bf9\u8bdd');
  for (const [english, translated] of [['Ready', '就绪'], ['Connecting', '连接中'], ['Enabled', '已启用'], ['Disabled', '未启用']]) {
    expect(t(english!)).toBe(language === 'en' ? english : translated);
  }
  const activity = agentActivity({ metadata: { kind: 'agent-part', partType: 'tool' },
    content: { type: 'tool', status: 'success', tool: 'read', input: { path: '\u9879\u76ee.md' }, output: '\u539f\u59cb\u5185\u5bb9' } });
  expect(activity?.action).toBe(language === 'en' ? 'Read' : '\u8bfb\u53d6');
  expect(activity?.target).toBe('\u9879\u76ee.md');
  expect(activity?.sections[1].value).toBe('\u539f\u59cb\u5185\u5bb9');
  const waiting = agentActivity({ metadata: { kind: 'agent-part', partType: 'tool' },
    content: { type: 'tool', status: 'running', tool: 'read', input: { path: '\u9879\u76ee.md' } } },
    { id: 'approval', role: 'assistant', content: '', status: 'waiting_for_input' });
  expect(waiting?.label).toBe(language === 'en' ? 'Awaiting confirmation: Read' : '\u7b49\u5f85\u786e\u8ba4\u8bfb\u53d6');
  const search = agentActivity({ metadata: { kind: 'agent-part', partType: 'tool' },
    content: { type: 'tool', status: 'success', tool: 'grep', input: { directory: 'src', pattern: 'lookup' } } });
  expect(search?.target).toBe(language === 'en' ? '\u201clookup\u201d in src' : 'src \u4e2d \u201clookup\u201d');
  expect(t('Please enter {0}.', 'name {1}')).toContain('name {1}');
  const titles = language === 'en' ? ['Summarizing context...', 'Context summary completed', 'Context summary failed']
    : ['上下文总结正在执行中...', '上下文总结已完成', '上下文总结失败'];
  for (const [index, status] of ['running', 'success', 'failed'].entries()) {
    expect(agentActivity({ metadata: { kind: 'agent-part', partType: 'compaction', status }, content: { type: 'compaction', status } })?.title).toBe(titles[index]);
  }
});

it('has complete placeholders and falls back to English for untranslated technical errors', () => {
  for (const [message, translation] of Object.entries(chinese)) {
    const placeholders = (text: string) => [...text.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();
    expect(placeholders(translation), message).toEqual(placeholders(message));
  }
  initI18n({ preference: 'en' });
  expect(t('Unknown diagnostic: {0}', 'custom')).toBe('Unknown diagnostic: custom');
});

it.each([['en', 'workflow'], ['zh-CN', 'workflow'], ['en', 'conversation'], ['zh-CN', 'conversation']] as const)(
  'inspects author-provided %s names and storage for %s projects in the Core worker', async (language, projectType) => {
  initI18n({ preference: language });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'web-locale-'));
  const runtime = createWebRuntime(directory, path.join(directory, 'data'), () => undefined);
  try {
    await mkdir(path.join(directory, 'node_modules'));
    await symlink(await realpath(new URL('../../node_modules/steamharness', import.meta.url)), path.join(directory, 'node_modules/steamharness'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeProjectFixture(path.join(directory, 'package.json'), JSON.stringify({ id: '294b1eec-23fa-42cf-9fd3-2417f71c0570', name: 'Default name', version: '1.2.3', description: 'Original description', privateToken: 'not-public', type: 'module',
       defaultEntry: 'main', entries: [{entryId:'main',name:'Main',type:projectType,root:'.',entry:'index.ts',databases:[]}], projectInfo:{localizedNames: { EN: 'English name', 'zh-cn': '\u4e2d\u6587\u540d\u79f0' }}  }));
    await writeFile(path.join(directory, 'index.ts'), `
      const graph = steamharness.defineProject({ name: 'locale-fixture', async run() { return steamharness.createOutputPayload({ items: [] }); } });
      export const executor = steamharness.defineExecutor(${projectType === 'workflow' ? `
        { projectType: 'workflow', defaultEntrypoint: 'main', entrypoints: [steamharness.defineEntrypoint({ id: 'main', title: 'Main', workflow: graph, createInput: context => context.paramValues })] }`
        : `{ projectType: 'conversation', workflow: graph, createInput: context => context.paramValues }`});`);
    const result = await runtime.inspect([directory]);
    expect(result.errors).toEqual([]);
    expect(result.projects[0].aggregateName).toBe(language === 'en' ? 'English name' : '\u4e2d\u6587\u540d\u79f0');
    expect(result.projects[0].entryId).toBe('main');
    expect(result.projects[0].manifest).toEqual({ name: 'Default name', version: '1.2.3', description: 'Original description' });
  } finally { runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 15_000);
