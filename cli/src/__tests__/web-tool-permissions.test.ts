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
    'File tools', 'Knowledge', 'Shell commands', 'Data storage', 'Studio', 'Agent tools', 'Skills', 'Memory',
    'tikhub', 'minimax', 'issue_tracker', 'Other tools', 'Resource cards',
  ]);
  expect(f.root.querySelectorAll('tbody tr')).toHaveLength(19);
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

it('localizes section controls and counts without interpreting tool names or labels as HTML', () => {
  initI18n({ preference: 'zh-CN' });
  const f = fixture([{ name: 'read', label: '<img src=x onerror=alert(1)>' }, { name: '<project>_fetch', label: '获取资料' }]);
  expect(f.section('文件工具').textContent).toContain('<img src=x onerror=alert(1)>');
  expect(f.root.querySelector('img')).toBeNull();
  expect(f.section('<project>').querySelector('.tool-group-count')?.textContent).toBe('1 个工具');
  expect(f.root.querySelector('[type=search]')?.ariaLabel).toBe('搜索工具');
  f.search('获取'); expect(f.root.querySelector('.tool-count')?.textContent).toBe('匹配 1 / 2 个工具');
});

it('keeps an empty registry clear and free of empty sections', () => {
  const f = fixture([]);
  expect(f.sections()).toHaveLength(0); expect(f.root.querySelector('input')).toBeNull();
  expect(f.root.textContent).toContain('0 tools'); expect(f.root.textContent).toContain('No tools declared by this project');
});
