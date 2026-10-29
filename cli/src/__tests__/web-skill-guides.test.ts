// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { ConversationTools } from '../web/ui/conversation-tools';
import type { AgentSkillGuide } from 'steamharness';

const guides: AgentSkillGuide[] = [
  { id: 'project:workflow-generator', name: 'workflow-generator', description: 'Generate and repair projects.', source: 'project' },
  { id: 'builtin:i-have-adhd', name: 'i-have-adhd', description: 'Communication guide.', source: 'builtin' },
];
let dialogs: ConversationTools;
const load = vi.fn();
const tab = () => document.querySelector<HTMLButtonElement>('[data-tab=skills]')!;
const request = () => load.mock.calls.at(-1)![0] as string;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.ariaLabel === label || item.textContent === label)!;
beforeEach(() => {
  vi.useFakeTimers(); initI18n({ preference: 'en' }); load.mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  dialogs = new ConversationTools(undefined, { skills: { load } });
  dialogs.permissions({ fields: [], tools: [{ name: 'read' }, { name: 'skill', label: 'List and read skill guides' }] }, {}, vi.fn());
});
afterEach(() => {
  dialogs.close(); document.body.replaceChildren(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
});

it('lazily loads actual guides, counts both sources and preserves list state after a complete document preview', () => {
  expect(load).not.toHaveBeenCalled(); tab().click(); dialogs.skillsResult(request(), guides);
  expect(document.querySelectorAll('.skill-guide')).toHaveLength(2);
  expect(document.querySelector('.skill-count')?.textContent).toBe('2 skills');
  expect(document.querySelector('.skill-guides')?.textContent).not.toContain('List and read skill guides');
  expect(document.querySelectorAll('.skill-guides input[type=checkbox]')).toHaveLength(0);
  const search = document.querySelector<HTMLInputElement>('.skill-search input')!;
  search.value = 'generate'; search.dispatchEvent(new Event('input'));
  expect(document.querySelector('.skill-count')?.textContent).toBe('1 of 2 skills');
  const section = document.querySelector<HTMLElement>('[data-section=skills]')!; section.scrollTop = 145;
  const opener = button('Preview workflow-generator'); opener.click();
  expect(load.mock.calls.at(-1)?.[1]).toBe(guides[0].id);
  const content = '---\nname: workflow-generator\n---\n# Full guide\n' + '内容完整。\n'.repeat(45_000) + '\nTAIL_END';
  dialogs.skillsResult(request(), { skill: guides[0], content });
  expect(document.activeElement).toBe(button('Back to skills'));
  expect(document.querySelector('.skill-preview-document')?.textContent).toContain('TAIL_END');
  button('Markdown source').click();
  expect(document.querySelector('.skill-preview-source')?.textContent).toBe(content);
  expect((document.querySelector('.skill-preview-document') as HTMLElement).hidden).toBe(true);
  button('Back to skills').click();
  expect(search.value).toBe('generate'); expect(section.scrollTop).toBe(145); expect(document.activeElement).toBe(opener);
  expect(load).toHaveBeenCalledTimes(2);
});

it('ignores stale catalog and preview responses after refresh, Back and close', async () => {
  tab().click(); const first = request();
  dialogs.skillsResult(first, guides); button('Refresh skills').click(); const second = request();
  dialogs.skillsResult(first, []); expect(document.querySelectorAll('.skill-guide')).toHaveLength(2);
  dialogs.skillsResult(second, guides); button('Preview i-have-adhd').click(); const preview = request();
  button('Back to skills').click(); dialogs.skillsResult(preview, { skill: guides[1], content: '# Stale preview' });
  expect(document.querySelector('.skill-preview-document')).toBeNull();
  expect((document.querySelector('.skill-catalog') as HTMLElement).hidden).toBe(false);
  button('Refresh skills').click(); const late = request(); dialogs.close();
  dialogs.skillsResult(late, []); await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
});

it('shows loading, empty, filtered and retryable errors including timeouts', async () => {
  tab().click(); expect(document.querySelector('.skill-guides')?.getAttribute('aria-busy')).toBe('true');
  dialogs.skillsResult(request(), []); expect(document.querySelector('.skill-status')?.textContent).toContain('No skills available');
  button('Refresh skills').click(); dialogs.skillsResult(request(), undefined, 'Read failed');
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Read failed'); button('Retry').click();
  await vi.advanceTimersByTimeAsync(40_000); expect(document.querySelector('[role=alert]')?.textContent).toContain('timed out');
  button('Retry').click(); dialogs.skillsResult(request(), guides);
  const search = document.querySelector<HTMLInputElement>('.skill-search input')!; search.value = 'absent'; search.dispatchEvent(new Event('input'));
  expect(document.querySelector('.skill-status')?.textContent).toBe('No matching skills');
});

it('keeps preview loading and retry states reachable beside the return control, then restores the catalog', () => {
  tab().click(); dialogs.skillsResult(request(), guides); button('Preview workflow-generator').click();
  expect(document.activeElement).toBe(button('Back to skills'));
  expect(document.querySelector('.skill-preview')?.textContent).toContain('Loading...');
  expect(document.querySelector('.skill-status')?.closest('[hidden]')).toBeNull();
  dialogs.skillsResult(request(), undefined, 'Guide temporarily unavailable');
  expect(document.querySelector('.skill-preview [role=alert]')?.textContent).toContain('Guide temporarily unavailable');
  button('Retry').click();
  expect(document.querySelectorAll('.skill-preview [role=status]')).toHaveLength(1);
  dialogs.skillsResult(request(), { skill: guides[0], content: '# Ready\nFull guide after retry.' });
  expect(document.querySelector('.skill-preview')?.textContent).toContain('Full guide after retry.');
  expect(document.querySelector('.skill-status')?.getAttribute('hidden')).not.toBeNull();
  expect(document.activeElement).toBe(button('Back to skills'));
  button('Back to skills').click(); button('Refresh skills').click();
  expect(document.querySelector('.skill-status')?.textContent).toBe('Loading...');
  expect(document.querySelector('.skill-status')?.closest('[hidden]')).toBeNull();
  dialogs.skillsResult(request(), guides);
  expect(document.querySelectorAll('.skill-guide')).toHaveLength(2);
});

it('localizes real metadata and sanitizes document HTML, scripts and unsafe links', () => {
  initI18n({ preference: 'zh-CN' }); tab().click();
  const guide = { ...guides[0], name: '<img src=x onerror=alert(1)>', description: '<script>bad()</script>' };
  dialogs.skillsResult(request(), [guide]);
  expect(document.querySelector('.skill-guide-heading strong')?.textContent).toBe(guide.name);
  expect(document.querySelector('.skill-guide-badge')?.textContent).toBe('项目技能');
  expect(document.querySelector('.skill-guide img, .skill-guide script')).toBeNull();
  document.querySelector<HTMLButtonElement>('.skill-guide')!.click();
  dialogs.skillsResult(request(), { skill: guide, content: '# 说明\n<script>bad()</script>\n[bad](javascript:alert%281%29)\n[relative](/api/message)\n[external](https://example.com)\n![local](/api/private)\n<input oninput="bad()">' });
  const article = document.querySelector('.skill-preview-document')!;
  expect(article.querySelector('script, [oninput], [href^="javascript:"], [href^="/"], [src^="/"]')).toBeNull();
  expect(article.querySelector('a[href^="https:"]')?.getAttribute('rel')).toContain('noopener');
  expect(article.querySelector('input')?.disabled).toBe(true);
  expect(document.querySelector('.skill-preview-toolbar .skill-guide-badge')?.textContent).toBe('只读');
});
