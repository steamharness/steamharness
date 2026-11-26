// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { createDefaultProjectInfo } from '@steamharness/project-info';
import { projectInformation } from '../web/ui/project-information';
import type { Project } from '../web/workflow-types';

const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/project',entries:[{entryId:"main",name:"Main",type:'bot',root:".",entry:"index.ts"}], id: '448a05e4-6f18-4f62-b99e-413790796f4b', name: 'Display name',
  manifest: { name: 'package-name', version: '1.2.3', description: 'Original description' },
  uri: 'file:///project', folderPath: '/project', projectType: 'bot', fields: [], entrypoints: [] };
afterEach(() => initI18n({ preference: 'zh-CN' }));

const rows = (view: ParentNode) => [...view.querySelectorAll('dt')].map(label => [label.textContent, label.nextElementSibling?.textContent]);

it.each(['en', 'zh-CN'] as const)('shows authored metadata and project entries in %s', language => {
  initI18n({ preference: language });
  const zh = language === 'zh-CN';
  const view = projectInformation({ ...project, distribution: 'source', projectInfo: { ...createDefaultProjectInfo(),
    localizedNames: { en: 'Display name', 'zh-CN': '项目名称' }, declarations: ['multilingual', 'custom'],
    platformSupport: { mode: 'specific', platforms: ['macos', 'linux'] },
  }, entrypoints: [{ id: 'default', title: 'Original entrypoint', fields: [] }], defaultEntrypoint: 'default' });
  expect(view.querySelector('.lp-detail-title')?.textContent).toBe('Test aggregate');
  expect(view.querySelector('.lp-detail-description')?.textContent).toBe('Original description');
  expect(rows(view.querySelector('.lp-detail-facts')!).map(([, value]) => value)).toEqual([
    zh ? '源码' : 'Source', 'Bot', '1.2.3', 'package-name', '/project', project.id,
  ]);
  const [declaration, names, entrypoints] = view.querySelectorAll<HTMLDetailsElement>('details');
  expect(declaration.open).toBe(true);
  expect(rows(declaration).map(([, value]) => value)).toEqual(['macOS, linux', zh ? '多语言, custom' : 'Multiple languages, custom']);
  expect(rows(names)).toEqual([['en', 'Display name'], ['zh-CN', '项目名称']]);
  expect(rows(entrypoints)).toEqual([['Original entrypoint', zh ? 'default（默认）' : 'default (default)']]);
  expect(view.querySelector('[data-entry-id=main] .lp-entry-default')?.textContent).toBe(zh ? '默认入口' : 'Default');
  expect(view.querySelector('button, .lp-project-usage')).toBeNull();
});

it('shows the assistant working directory and supplies useful fallbacks for optional display metadata', () => {
  initI18n({ preference: 'en' });
  const view = projectInformation({ ...project, manifest: undefined, assistant: { workdir: '/opened-folder', roots: [] } });
  expect(rows(view)).toEqual(expect.arrayContaining([
    ['Default name', project.name], ['Version', 'Not declared'], ['Working directory', '/opened-folder'], ['Declarations', 'Not declared'],
  ]));
});
