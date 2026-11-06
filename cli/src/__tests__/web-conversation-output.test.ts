// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationOutput } from '../web/ui/conversation-output';
import type { Attachment, ConversationMessage, OutputItem } from '../web/workflow-types';

const outputs: ConversationOutput[] = [];
afterEach(() => { for (const output of outputs.splice(0)) output.dispose(); document.body.replaceChildren(); });

it.each(['en', 'zh-CN'] as const)('shows sleep end times during the wait and after completion and replay in %s', async language => {
  const { initI18n } = await import('@steamharness/i18n'); initI18n({ preference: language });
  try {
    const wakeAt = Date.parse('2026-11-06T10:03:00Z'), endedAt = wakeAt + 125;
    const item = (status: 'running' | 'success'): OutputItem => ({ id: 'sleep', title: 'sleep', metadata: { kind: 'agent-part', partType: 'tool', status },
      content: { tool: 'sleep', input: { seconds: 180 }, output: { content: [{ type: 'text', text: status === 'running' ? 'Waiting' : 'Finished' }],
        details: { seconds: 180, wakeAt, ...(status === 'success' ? { endedAt } : {}) } } } });
    const root = document.createElement('div'); document.body.append(root);
    const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {} }); outputs.push(output);
    output.update({ role: 'assistant', status: 'running', content: '', items: [item('running')] }, 'project', 'main', 'session', []);
    const waiting = root.querySelector<HTMLDetailsElement>('[data-kind=sleep]')!;
    expect(waiting.querySelector('summary')?.textContent).toContain(language === 'en' ? 'Waiting until' : '预计结束');
    expect(waiting.querySelector('summary')?.textContent).toContain('2026');
    expect(waiting.querySelector('summary')?.getAttribute('aria-label')).toContain(language === 'en' ? 'Waiting until' : '预计结束');
    waiting.open = true; waiting.dispatchEvent(new Event('toggle'));
    expect(waiting.textContent).toContain(language === 'en' ? 'Expected end time' : '预计结束时间');
    expect(waiting.textContent).not.toContain(language === 'en' ? 'Actual end time' : '实际结束时间');
    const message: ConversationMessage = { role: 'assistant', status: 'success', content: '', items: [item('success')] };
    output.update(message, 'project', 'main', 'session', []);
    expect(root.querySelector('[data-kind=sleep]')).toBe(waiting);
    expect(waiting.querySelector('summary')?.textContent).toContain(language === 'en' ? 'Wait completed at' : '结束时间');
    expect(waiting.textContent).toContain(language === 'en' ? 'Actual end time' : '实际结束时间');
    const replayRoot = document.createElement('div'); document.body.append(replayRoot);
    const replay = new ConversationOutput(replayRoot, { copy() {}, plan() {}, file() {}, image() {}, resource() {} }); outputs.push(replay);
    replay.update(message, 'project', 'main', 'session', []);
    expect(replayRoot.querySelector('summary')?.textContent).toBe(root.querySelector('summary')?.textContent);
  } finally { initI18n({ preference: 'en' }); }
});

it('keeps file links actionable through streaming, collapsed output and history replay', () => {
  const root = document.createElement('div'), path = vi.fn(); document.body.append(root);
  const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, path, image() {}, resource() {} }); outputs.push(output);
  for (const status of ['running', 'success', 'success'] as const) {
    output.update({ role: 'assistant', status, content: '', items: [
      { id: 'body', content: '[configuration](./configuration.json:5:2)', contentType: 'markdown' },
      { id: 'detail', content: '`src/main.ts`', contentType: 'markdown', collapsed: true },
      { id: 'plain', content: 'File: /work/main.ts:8', contentType: 'text' },
    ] }, 'project', 'main', 'session', []);
    root.querySelector<HTMLAnchorElement>('a')!.click(); expect(path).toHaveBeenLastCalledWith({ path: './configuration.json', line: 5, column: 2 });
    root.querySelector<HTMLAnchorElement>('details a')!.click(); expect(path).toHaveBeenLastCalledWith({ path: 'src/main.ts' });
    root.querySelector<HTMLAnchorElement>('.plain-output a')!.click(); expect(path).toHaveBeenLastCalledWith({ path: '/work/main.ts', line: 8 });
  }
  expect(path).toHaveBeenCalledTimes(9);
});

it('signs a shared attachment list once per update and invalidates unchanged Markdown when a preview changes', () => {
  const root = document.createElement('div'); document.body.append(root);
  const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {} }); outputs.push(output);
  const files: Attachment[] = [{ id: 'file', name: 'image.png', path: '/image.png', size: 1, previewUrl: '/old.png', mimeType: 'image/png', kind: 'image', storage: 'local', createdAt: '2026-10-22T00:00:00Z' }];
  const map = vi.spyOn(files, 'map');
  const message: ConversationMessage = { role: 'assistant', content: '', status: 'success', items: Array.from({ length: 100 }, (_, index) => ({
    id: `text-${index}`, content: '[image](/image.png)', contentType: 'markdown',
  })) };
  output.update(message, 'project', "main", 'session', files);
  expect(map).toHaveBeenCalledOnce();
  const first = root.firstElementChild; expect(first!.querySelector('a')!.getAttribute('href')).toBe('/old.png');
  output.update(message, 'project', "main", 'session', files); expect(root.firstElementChild).toBe(first);
  files[0].previewUrl = '/new.png'; output.update(message, 'project', "main", 'session', files);
  expect(root.firstElementChild).not.toBe(first); expect(root.firstElementChild!.querySelector('a')!.getAttribute('href')).toBe('/new.png');
});

it.each(['recovery', 'length', 'lost-call'])('silently continues %s while preserving network retry feedback and answer text', kind => {
  const root = document.createElement('div'); document.body.append(root);
  const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {} }); outputs.push(output);
  const retry = (id: string, kind: string): OutputItem => ({ id, content: { type: 'retry', kind, attempt: 1, maxAttempts: 10, reason: 'fixture' },
    contentType: 'json', metadata: { kind: 'agent-part', partType: 'retry', status: 'success' } });
  const items = [{ id: 'body', content: 'Partial answer', contentType: 'markdown' }, retry('internal', kind), retry('network', 'dropped')];
  output.update({ role: 'assistant', status: 'running', content: '', items }, 'project', "main", 'conversation', []);
  expect(root.querySelectorAll('[data-kind="retry"]')).toHaveLength(1);
  expect(root.querySelector('[data-item-id="internal"]')).toBeNull();
  expect(root.querySelector('[data-item-id="network"]')).not.toBeNull();
  expect(root.querySelector('.pending')?.textContent).toBe('Responding...');
  expect(root.textContent).toContain('Partial answer');
  output.update({ role: 'assistant', status: 'success', content: '', items }, 'project', "main", 'conversation', []);
  expect(root.querySelectorAll('[data-kind="retry"]')).toHaveLength(1);
  expect(root.querySelector('.pending')).toBeNull();
});

it('keeps the retry at its interruption point through completion, expansion and history replay', () => {
  const items: OutputItem[] = [
    { id: 'before', content: 'Before interruption', contentType: 'markdown', metadata: { kind: 'agent-part', partType: 'text' } },
    { id: 'retry', content: { type: 'retry', status: 'success', attempt: 1, maxAttempts: 10, reason: 'terminated' },
      contentType: 'json', collapsed: true, metadata: { kind: 'agent-part', partType: 'retry', status: 'success' } },
    { id: 'after', content: 'Resumed answer', contentType: 'markdown', metadata: { kind: 'agent-part', partType: 'text' } },
  ];
  const message: ConversationMessage = { role: 'assistant', status: 'running', content: '', items: items.slice(0, 2) };
  for (const replay of [false, true]) {
    const root = document.createElement('div'); document.body.append(root);
    const output = new ConversationOutput(root, { copy() {}, plan() {}, file() {}, image() {}, resource() {} }); outputs.push(output);
    output.update(message, 'project', "main", 'conversation', []);
    const retry = root.querySelector<HTMLDetailsElement>('[data-kind="retry"]')!;
    retry.open = true; retry.dispatchEvent(new Event('toggle'));
    output.update({ ...message, status: 'success', items }, 'project', "main", 'conversation', []);
    expect(root.querySelectorAll('[data-kind="retry"]')).toHaveLength(1);
    expect(root.querySelector('[data-kind="retry"]')).toBe(retry);
    expect(retry.open).toBe(true);
    expect(retry.querySelector('pre')?.textContent).toContain('terminated');
    expect(Array.from(root.children, child => child.className)).toEqual(['message-content', 'activity-group single-activity', 'message-content']);
    expect(root.firstElementChild?.textContent).toContain('Before interruption');
    expect(root.lastElementChild?.textContent).toContain('Resumed answer');
    if (!replay) { message.status = 'success'; message.items = items; }
  }
});

it.each(['en', 'zh-CN'] as const)('labels the second resource action for a side editor in %s', async language => {
  const { initI18n } = await import('@steamharness/i18n'); initI18n({preference:language});
  const root=document.createElement('div');document.body.append(root);const resource=vi.fn();
  const output=new ConversationOutput(root,{copy(){},plan(){},file(){},image(){},resource});outputs.push(output);
  output.update({role:'assistant',status:'success',content:'',items:[{id:'tool',metadata:{kind:'agent-part',partType:'tool'},content:{type:'tool',tool:'kb_get_document',status:'success',input:{},output:{details:{resourceCard:{kind:'knowledge',title:'Guide',target:{source:'local',projectId:'project',entryId:'main',knowledgeBase:'docs',documentId:'guide'}}}}}}]},'project','main','session',[]);
  const button=root.querySelector<HTMLButtonElement>('[data-action=window]')!;
  expect(button.title).toBe(language==='en'?'Open beside':'在侧边编辑器中打开');
  expect(button.getAttribute('aria-label')).toBe(button.title);button.click();expect(resource).toHaveBeenCalledWith(expect.objectContaining({kind:'knowledge'}),'window');
  initI18n({preference:'en'});
});
