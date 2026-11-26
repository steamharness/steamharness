import { describe, expect, it, vi } from 'vitest';
import { renderProjectDetails, type ProjectDetailsData } from '../details';

const project: ProjectDetailsData = {
	kind: 'folder', uri: 'file:///project', name: 'Project <em>title</em>', description: 'Description\n<p>as typed</p>',
	projectId: 'project-id', path: '/some/very/long/path', distribution: 'release', version: '1.2.3', projectType: 'bot',
	avatarUrl: 'https://example.invalid/not-a-local-image.svg',
	entries: [
		{ entryId: 'bot', name: 'Agent', type: 'bot', primary: true, avatarUrl: 'data:image/gif;base64,AA==' },
		{ entryId: 'workflow', name: 'Control', type: 'workflow', primary: false, available: false },
	],
};

describe('shared project details', () => {
	it.each(['en', 'zh-CN'])('has a read-only view with localized headings and copyable project data (%s)', language => {
		const zh = language === 'zh-CN';
		const page = renderProjectDetails(document, project, (en, cn) => zh ? cn : en, { title: 'h3', formatLabel: zh ? '发行版' : 'Release' });
		expect(page.querySelector('h3')?.textContent).toBe(project.name);
		expect(page.querySelector('h4')?.textContent).toBe(zh ? '项目入口' : 'Project entries');
		expect(page.querySelector('.lp-detail-description')?.textContent).toBe(project.description);
		expect(page.querySelector('p p, em, header img, button, .lp-detail-actions, .lp-detail-secondary, .lp-project-usage')).toBeNull();
		expect([...page.querySelectorAll('dd')].map(node => node.textContent)).toEqual([
			zh ? '发行版' : 'Release', zh ? '多入口' : 'Multi-entry', '1.2.3', project.path, project.projectId,
		]);
		expect(page.querySelector('.lp-entry-default')?.textContent).toBe(zh ? '默认入口' : 'Default');
		expect(page.querySelector('[data-entry-id=bot] img')?.getAttribute('src')).toBe(project.entries?.[0].avatarUrl);
	});

	it('adds host actions, window status and usage without changing the main layout', () => {
		const action = document.createElement('button'), secondary = document.createElement('section'), usage = document.createElement('section');
		const openEntry = vi.fn();
		const page = renderProjectDetails(document, { ...project, missing: true }, en => en, {
			actions: [action], secondaryActions: secondary, usage, openEntry, showWindowStatus: true,
		});
		expect(page.querySelector('h1')?.textContent).toBe(project.name);
		expect(page.querySelector('.lp-detail-actions > button')).toBe(action);
		expect(usage.previousElementSibling).toBe(secondary);
		expect(usage.nextElementSibling?.className).toBe('lp-detail-entries');
		expect([...page.querySelectorAll('dd')].map(node => node.textContent)).toContain('Not found');
		expect(page.querySelector('[data-entry-id=workflow] button')).toBeNull();
		expect(page.querySelector('.lp-entry-unavailable')?.textContent).toBe('Unavailable');
		page.querySelector<HTMLButtonElement>('[aria-label="Open entry: Agent"]')?.click();
		expect(openEntry).toHaveBeenCalledExactlyOnceWith('bot');
	});
});
