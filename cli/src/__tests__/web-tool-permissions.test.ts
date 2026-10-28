// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initI18n } from '@steamharness/i18n';
import { ConversationTools } from '../web/ui/conversation-tools';
import type { Tool, ToolPolicies } from '../web/workflow-types';

beforeEach(() => {
  initI18n({ preference: 'en' });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  document.body.replaceChildren(); initI18n({ preference: 'zh-CN' });
});

function fixture(tools: Tool[], policies: ToolPolicies = {}) {
  const dialogs = new ConversationTools(), changed = vi.fn();
  dialogs.permissions({ fields: [], tools }, policies, changed);
  const root = document.querySelector<HTMLElement>('.tool-permissions')!;
  const sections = () => Array.from(root.querySelectorAll<HTMLDetailsElement>('details'));
  const section = (title: string) => sections().find(details => details.querySelector('.tool-group-title')?.textContent === title)!;
  const search = (query: string) => {
    const input = root.querySelector<HTMLInputElement>('[type=search]')!; input.value = query; input.dispatchEvent(new Event('input'));
  };
  return { dialogs, changed, root, sections, section, search };
}

it('groups interleaved built-in, project and MCP tools without losing or duplicating registrations', () => {
  const f = fixture([
    { name: 'read' }, { name: 'kb_list_documents' }, { name: 'bash' }, { name: 'kv_get_value' },
    { name: 'write' }, { name: 'workflow-studio_open_file' }, { name: 'update_plan' }, { name: 'skill' },
    { name: 'kb_get_document' }, { name: 'workflow-memory_global_memory' }, { name: 'db_status' },
    { name: 'tikhub_search_posts' }, { name: 'minimax_understand_media' }, { name: 'tikhub_fetch_post' },
    { name: 'mcp__issue_tracker__list' }, { name: 'mcp__issue_tracker__get' }, { name: 'custom' },
    { name: 'workflow-ui_present_card' }, { name: 'tool_search' },
  ]);
  expect(f.sections().map(section => section.querySelector('.tool-group-title')?.textContent)).toEqual([
    'File tools', 'Knowledge', 'Shell commands', 'Data storage', 'Studio', 'Agent tools', 'Memory',
    'tikhub', 'minimax', 'issue_tracker', 'Other tools', 'Resource cards',
  ]);
  expect(f.root.querySelectorAll('tbody tr')).toHaveLength(18);
  expect(f.sections().every(section => !section.open)).toBe(true);
  expect(f.section('File tools').querySelector('.tool-group-count')?.textContent).toBe('2 tools');
  expect(f.section('Knowledge').querySelector('tbody')?.textContent).toBe('kb_list_documentskb_get_document');
  const files = f.section('File tools');
  files.querySelector('summary')!.click();
  expect(files.open).toBe(true);
  files.querySelector('summary')!.click();
  expect(files.open).toBe(false);
  expect(f.changed).not.toHaveBeenCalled();
});

it('searches names, labels and descriptions, expands matches and restores sections after clearing', async () => {
  const f = fixture([
    { name: 'read', label: 'Read file' },
    { name: 'kb_get_document', label: 'Find a note', description: 'Retrieve stored Markdown.' },
    { name: 'kb_delete_document', label: 'Delete a note' }, { name: 'kv_get_value' },
  ]);
  const files = f.section('File tools'), knowledge = f.section('Knowledge');
  const toggled = new Promise(resolve => files.addEventListener('toggle', resolve, { once: true }));
  files.querySelector('summary')!.click();
  await toggled;
  for (const query of ['KB_GET', 'find a note', 'stored markdown']) {
    f.search(query);
    expect(files.hidden).toBe(true); expect(knowledge.hidden).toBe(false); expect(knowledge.open).toBe(true);
    expect(Array.from(knowledge.querySelectorAll('tbody tr')).filter(row => !(row as HTMLElement).hidden)).toHaveLength(1);
    expect(f.root.querySelector('.tool-count')?.textContent).toBe('1 of 4 tools');
  }
  f.search('no such tool');
  expect(f.sections().every(section => section.hidden)).toBe(true);
  expect(f.root.lastElementChild?.textContent).toBe('No matching tools'); expect((f.root.lastElementChild as HTMLElement).hidden).toBe(false);
  f.search('  ');
  expect(f.sections().every(section => !section.hidden)).toBe(true);
  expect(files.open).toBe(true); expect(knowledge.open).toBe(false);
  expect(f.root.querySelector('.tool-count')?.textContent).toBe('4 tools');
  f.dialogs.close(); f.dialogs.permissions({ fields: [], tools: [{ name: 'read' }, { name: 'kb_get_document' }] }, {}, f.changed);
  const reopened = document.querySelectorAll<HTMLDetailsElement>('.tool-permission-section');
  expect(reopened[0].open).toBe(true); expect(reopened[1].open).toBe(false);
  expect(f.changed).not.toHaveBeenCalled();
});

it('restores a just-opened section when search starts before its native toggle event', () => {
  const f = fixture([{ name: 'read' }, { name: 'kb_get_document' }]);
  const files = f.section('File tools'); files.querySelector('summary')!.click();
  f.search('kb_get'); f.search('');
  expect(files.open).toBe(true); expect(f.section('Knowledge').open).toBe(false);
});

it('keeps hidden tool policies and independent defaults when changing a filtered tool', () => {
  const policies = { read: { enabled: false, autoApprove: true } };
  const f = fixture([
    { name: 'read', label: 'Duplicate label' },
    { name: 'kb_get_document', label: 'Duplicate label', enabled: false, autoApprove: true },
    { name: 'custom' },
  ], policies);
  const read = f.section('File tools').querySelector<HTMLInputElement>('input')!;
  expect(read.checked).toBe(false);
  f.search('kb_get');
  const [enabled, autoApprove] = f.section('Knowledge').querySelectorAll<HTMLInputElement>('input');
  expect(enabled.ariaLabel).toContain('kb_get_document');
  expect(enabled.checked).toBe(false); expect(autoApprove.checked).toBe(true);
  enabled.click();
  const first = f.changed.mock.calls[0][0];
  expect(first).toEqual({ read: { enabled: false, autoApprove: true }, kb_get_document: { enabled: true, autoApprove: true }, custom: { enabled: true, autoApprove: false } });
  autoApprove.click();
  expect(f.changed.mock.calls[1][0].kb_get_document).toEqual({ enabled: true, autoApprove: false });
  expect(first.kb_get_document.autoApprove).toBe(true);
  expect(policies).toEqual({ read: { enabled: false, autoApprove: true } });
  f.search(''); expect(read.checked).toBe(false);
});

it('localizes section controls and counts and displays descriptions without interpreting tool text as HTML', () => {
  initI18n({ preference: 'zh-CN' });
  const description = '先列出技能。\n再读取 SKILL.md；示例：<script>read()</script>';
  const f = fixture([{ name: 'read', label: '<img src=x onerror=alert(1)>', description }, { name: '<project>_fetch', label: '获取资料' }]);
  expect(f.section('文件工具').textContent).toContain('<img src=x onerror=alert(1)>');
  expect(f.root.querySelector('img')).toBeNull();
  expect(f.section('文件工具').querySelector('.permission-tool-description')?.textContent).toBe(description);
  expect(f.root.querySelector('script')).toBeNull();
  expect(f.section('<project>').querySelector('.tool-group-count')?.textContent).toBe('1 个工具');
  expect(f.root.querySelector('[type=search]')?.ariaLabel).toBe('搜索工具');
  f.search('获取'); expect(f.root.querySelector('.tool-count')?.textContent).toBe('匹配 1 / 2 个工具');
});

it('keeps an empty registry clear and free of empty sections', () => {
  const f = fixture([]);
  expect(f.sections()).toHaveLength(0); expect(f.root.querySelector('input')).toBeNull();
  expect(f.root.textContent).toContain('0 tools'); expect(f.root.textContent).toContain('No tools declared by this project');
});

it('separates skill guides into a read-only tab and preserves their policy when editing tools', () => {
  const policies = { skill: { enabled: false, autoApprove: false } };
  const f = fixture([
    { name: 'skill', label: 'List and read skill guides', description: 'Read SKILL.md and references.\nActions use other tools.' },
    { name: 'read' },
  ], policies);
  const [toolsTab, skillsTab] = document.querySelectorAll<HTMLButtonElement>('.project-information-tabs [role=tab]');
  const skills = document.querySelector<HTMLElement>('.skill-guides')!;
  expect(document.querySelector('.conversation-dialog h2')?.textContent).toBe('Project information');
  expect(toolsTab.textContent).toBe('Tools'); expect(skillsTab.textContent).toBe('Skills');
  expect(toolsTab.getAttribute('aria-selected')).toBe('true'); expect((skills.closest('[role=tabpanel]') as HTMLElement).hidden).toBe(true);
  expect(f.root.querySelector('.tool-count')?.textContent).toBe('1 tools');
  expect(f.root.textContent).not.toContain('List and read skill guides');
  skillsTab.click();
  expect((f.root.closest('[role=tabpanel]') as HTMLElement).hidden).toBe(true); expect((skills.closest('[role=tabpanel]') as HTMLElement).hidden).toBe(false);
  expect(skills.querySelector('.skill-guide-heading h3')?.textContent).toBe('List and read skill guides');
  expect(skills.querySelector('.skill-guide-name')?.textContent).toBe('skill');
  expect(skills.querySelector('.skill-guide-badge')?.textContent).toBe('Read-only');
  expect(skills.querySelector('.skill-guide-description')?.textContent).toBe('Read SKILL.md and references.\nActions use other tools.');
  expect(skills.querySelector('input, select, button, .permissions-table')).toBeNull();
  expect(skills.textContent).not.toContain('Auto-approve');
  expect(f.changed).not.toHaveBeenCalled();
  toolsTab.click();
  f.section('File tools').querySelector<HTMLInputElement>('input')!.click();
  const next = f.changed.mock.calls[0][0];
  expect(next).toEqual({ read: { enabled: false, autoApprove: false }, skill: { enabled: false, autoApprove: false } });
  next.skill.enabled = true;
  expect(policies).toEqual({ skill: { enabled: false, autoApprove: false } });
  expect(skills.querySelector('.skill-guide-badge')?.textContent).toBe('Read-only');
});

it('supports keyboard tabs and retains tool search and collapse state across tab changes', () => {
  const f = fixture([{ name: 'read' }, { name: 'kb_get_document' }, { name: 'skill' }]);
  const [tools, skills] = document.querySelectorAll<HTMLButtonElement>('.project-information-tabs [role=tab]');
  for (const tab of [tools, skills]) {
    const panel = document.getElementById(tab.getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('role')).toBe('tabpanel'); expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
  }
  f.section('File tools').querySelector('summary')!.click();
  f.search('kb_get');
  tools.focus();
  tools.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(skills); expect(skills.tabIndex).toBe(0); expect(tools.tabIndex).toBe(-1);
  expect(skills.getAttribute('aria-selected')).toBe('true'); expect((f.root.closest('[role=tabpanel]') as HTMLElement).hidden).toBe(true);
  skills.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(tools); expect((f.root.closest('[role=tabpanel]') as HTMLElement).hidden).toBe(false);
  expect(f.root.querySelector<HTMLInputElement>('[type=search]')?.value).toBe('kb_get');
  expect(f.section('Knowledge').open).toBe(true); expect(f.section('File tools').hidden).toBe(true);
  tools.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(document.activeElement).toBe(skills);
  skills.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(document.activeElement).toBe(tools);
  tools.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  expect(document.activeElement).toBe(skills);
  tools.click(); f.search('');
  expect(f.section('File tools').open).toBe(true); expect(f.section('Knowledge').open).toBe(false);
  expect(f.changed).not.toHaveBeenCalled();
});

it('opens skill-only projects on Skills and keeps an undeclared skill tab empty', () => {
  const f = fixture([{ name: 'skill' }]);
  expect(document.querySelector('[data-tab=skills]')?.getAttribute('aria-selected')).toBe('true');
  expect((f.root.closest('[role=tabpanel]') as HTMLElement).hidden).toBe(true); expect((document.querySelector('.skill-guides')!.closest('[role=tabpanel]') as HTMLElement).hidden).toBe(false);
  f.dialogs.close(); f.dialogs.permissions({ fields: [], tools: [{ name: 'read' }] }, {}, f.changed);
  document.querySelector<HTMLButtonElement>('[data-tab=skills]')!.click();
  expect(document.querySelector('.skill-guides')?.textContent).toContain('No skills declared by this project');
  expect(document.querySelector('.skill-guide')).toBeNull();
  expect(f.changed).not.toHaveBeenCalled();
});

it('localizes skill tabs and renders skill labels and descriptions as inert text', () => {
  initI18n({ preference: 'zh-CN' });
  const description = '读取 <script>alert(1)</script> 和 SKILL.md。';
  fixture([{ name: 'skill', label: '<img src=x onerror=alert(1)>', description }]);
  expect(document.querySelector('.conversation-dialog h2')?.textContent).toBe('项目信息');
  expect(Array.from(document.querySelectorAll('.project-information-tabs button'), tab => tab.textContent)).toEqual(['工具', '技能']);
  const skills = document.querySelector('.skill-guides')!;
  expect(skills.querySelector('h3')?.textContent).toBe('<img src=x onerror=alert(1)>');
  expect(skills.querySelector('.skill-guide-description')?.textContent).toBe(description);
  expect(skills.querySelector('.skill-guide-badge')?.textContent).toBe('只读');
  expect(skills.querySelector('img, script')).toBeNull(); expect(skills.textContent).not.toContain('自动批准');
});
