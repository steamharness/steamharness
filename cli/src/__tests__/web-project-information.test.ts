import { afterEach, expect, it } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { createDefaultProjectInfo } from '@steamharness/project-info';
import { projectInformation } from '../web/ui/project-information';
import type { Project } from '../web/workflow-types';

const project: Project = { id: '448a05e4-6f18-4f62-b99e-413790796f4b', name: 'Display name',
  manifest: { name: 'package-name', version: '1.2.3', description: 'Original description' },
  uri: 'file:///project', folderPath: '/project', projectType: 'conversation', fields: [], entrypoints: [] };
afterEach(() => initI18n({ preference: 'zh-CN' }));

it.each(['en', 'zh-CN'] as const)('shows authored metadata in %s and preserves declared names and permission direction', language => {
  initI18n({ preference: language });
  const sections = projectInformation({ ...project, projectInfo: { ...createDefaultProjectInfo(),
    localizedNames: { en: 'Display name', 'zh-CN': '\u9879\u76ee\u540d\u79f0' }, declarations: ['multilingual', 'custom'],
    platformSupport: { mode: 'specific', platforms: ['macos', 'linux'] },
    relatedProjects: [{ alias: 'notes', projectId: 'a79eef03-8c24-4353-a867-edc28e8f5c20',
      grantToRelatedProject: { read: { mode: 'prefixes', prefixes: ['notes/'] }, write: { mode: 'none' },
        knowledge: { read: { mode: 'all' }, write: { mode: 'none' } } } }],
  }, entrypoints: [{ id: 'main', title: 'Original entrypoint', fields: [] }], defaultEntrypoint: 'main' });
  expect(sections[0].title).toBe(language === 'en' ? 'Basic information' : '\u57fa\u672c\u4fe1\u606f');
  expect(sections[0].rows.map(row => row.value)).toEqual(['package-name', language === 'en' ? 'Conversation' : '\u5bf9\u8bdd', '1.2.3', project.id, '/project']);
  expect(sections[1].rows[1].value).toBe('macOS, linux');
  expect(sections[1].rows[2].value).toContain('custom');
  expect(sections[2].rows).toEqual([{ label: 'en', value: 'Display name' }, { label: 'zh-CN', value: '\u9879\u76ee\u540d\u79f0' }]);
  expect(sections[3].rows[1].value).toContain('notes/');
  expect(sections[3].rows[2].value).toBe(language === 'en' ? 'Not allowed' : '\u4e0d\u5141\u8bb8');
  expect(sections[3].rows[5].value).toBe(language === 'en' ? 'Not declared' : '\u672a\u58f0\u660e');
  expect(sections[4].rows[0].label).toBe('Original entrypoint');
});

it('shows the assistant working directory and supplies useful fallbacks for older descriptors', () => {
  initI18n({ preference: 'en' });
  const sections = projectInformation({ ...project, manifest: undefined, assistant: { workdir: '/opened-folder', roots: [] } });
  expect(sections[0].rows[0].value).toBe(project.name);
  expect(sections[0].rows[2].value).toBe('Not declared');
  expect(sections[0].rows[4]).toEqual({ label: 'Working directory', value: '/opened-folder' });
  expect(sections[1].rows[0].value).toBe('Not declared');
});
