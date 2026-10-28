// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Project } from '../web/workflow-types';
import type { AccountState } from '../web/workflow-auth-client';
import { accountAvatarUrl, updateProjectAvatar, updateUserAvatar } from '../web/ui/avatar';
import { AccountPanel } from '../web/ui/account';

const host = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
const projectInfo = vi.hoisted(() => vi.fn());
vi.mock('../web/ui/host', () => ({ acquireProjectHost: () => host }));
vi.mock('../web/ui/conversation-output', () => ({ ConversationOutput: class { update() {} dispose() {} } }));
vi.mock('../web/ui/conversation-tools', () => ({ ConversationTools: class { open = false; close() {} closeUsage() {} projectInfo = projectInfo; } }));

const project: Project = {entryId:"main",aggregateName:"Test aggregate",defaultEntry:"main",entryRoot:'/avatar-test',databases:[],entries:[{entryId:"main",name:"Main",type:'conversation',root:".",entry:"index.ts",databases:[]}], id: 'avatar-test', uri: 'file:///avatar-test', folderPath: '/avatar-test', name: 'Avatar Test', projectType: 'conversation', fields: [], entrypoints: [],
  projectCard: { icon: 'database', iconColor: '#123456', iconBackgroundColor: '#eeeeee' } };
const account: AccountState = { status: 'authenticated', serverUrl: 'http://localhost:7126', revision: 1,
  user: { userId: 'user', email: 'user@example.test', displayName: 'User', avatarUrl: '/storage/avatar.png' } };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); document.head.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); });

it('keeps message avatars in the requested positions, opens their identities, and refreshes history and streaming rows in place', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector) { return selector === ':popover-open' ? false : matches.call(this, selector); });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const style = document.createElement('style'); style.textContent = readFileSync(path.join(import.meta.dirname, '../web/ui/style.css'), 'utf8'); document.head.append(style);
  document.body.innerHTML = '<div id="app"></div>';
  await import('../web/ui/main');
  const messages = [{ id: 'user', role: 'user', content: 'Hello', createdAt: 1, contextEpoch: 1 }, { id: 'assistant', role: 'assistant', content: 'Answer', durationMs: 12000, status: 'success' }];
  const emit = (currentProject = project, currentAccount: AccountState | undefined = account) => { window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'state', project: currentProject, account: currentAccount, activeId: 'session', running: false,
    sessions: [{ id: 'session', title: 'Conversation', messages, createdAt: 1, updatedAt: 1 }],
  } })); vi.advanceTimersByTime(32); };
  emit();
  const user = document.querySelector<HTMLButtonElement>('.user > .message-avatar')!, assistant = document.querySelector<HTMLButtonElement>('.assistant .message-header > .message-avatar')!;
  expect(user.previousElementSibling?.className).toBe('message-body');
  expect(assistant.nextElementSibling?.className).toBe('message-heading');
  expect(assistant.nextElementSibling?.querySelector('.message-metadata')).not.toBeNull();
  expect(assistant.nextElementSibling?.textContent).toContain('Duration');
  expect(assistant.type).toBe('button'); expect(assistant.getAttribute('aria-haspopup')).toBe('dialog');
  expect(getComputedStyle(user).width).toBe('32px'); expect(getComputedStyle(user).flexShrink).toBe('0');
  expect(getComputedStyle(user.parentElement!).display).toBe('flex');
  expect(getComputedStyle(user.parentElement!.querySelector('.context-epoch')!).flexBasis).toBe('100%');
  expect(user.querySelector('img')?.src).toBe('http://localhost:7126/storage/avatar.png');
  expect(decodeURIComponent(assistant.querySelector('img')!.src)).toContain('stroke="#123456"');
  assistant.click(); expect(projectInfo).toHaveBeenLastCalledWith(project);
  user.click(); expect(host.postMessage).toHaveBeenLastCalledWith({ type: 'login' });
  const image = assistant.querySelector('img');
  for (let index = 0; index < 3; index++) { messages[1].content += '.'; emit(); }
  expect(document.querySelector('.assistant .message-avatar')).toBe(assistant);
  expect(assistant.querySelector('img')).toBe(image);
  const changed = { ...project, projectCard: { ...project.projectCard!, iconColor: '#654321' } };
  emit(changed, { ...account, user: { ...account.user!, avatarUrl: 'data:image/png;base64,YQ==' } });
  expect(user.querySelector('img')?.src).toBe('data:image/png;base64,YQ==');
  expect(decodeURIComponent(assistant.querySelector('img')!.src)).toContain('stroke="#654321"');
  assistant.click(); expect(projectInfo).toHaveBeenLastCalledWith(changed);
  emit(changed, { status: 'signed-out', serverUrl: '', revision: 2 });
  expect(user.querySelector('img')).toBeNull(); expect(user.querySelector('.codicon-account')).not.toBeNull();
  window.dispatchEvent(new Event('pagehide'));
});

it('ignores image events from an old account and retains a fallback on broken images', () => {
  const root = document.createElement('button'); updateUserAvatar(root, account);
  const old = root.querySelector('img')!;
  updateUserAvatar(root, { ...account, user: { ...account.user!, avatarUrl: 'data:image/png;base64,bmV3' } });
  const current = root.querySelector('img')!, fallback = root.querySelector<HTMLElement>('.codicon')!;
  current.dispatchEvent(new Event('load')); expect(fallback.hidden).toBe(true); expect(current.hidden).toBe(false);
  old.dispatchEvent(new Event('error')); expect(fallback.hidden).toBe(true); expect(current.hidden).toBe(false);
  current.dispatchEvent(new Event('error')); expect(fallback.hidden).toBe(false); expect(current.hidden).toBe(true);
  updateUserAvatar(root); expect(root.querySelector('img')).toBeNull();
  old.dispatchEvent(new Event('load')); expect(root.querySelector<HTMLElement>('.codicon')!.hidden).toBe(false);
});

it('uses the type default on older projects and supports safe absolute avatars without a configured Server', () => {
  const root = document.createElement('button'); updateProjectAvatar(root, { projectType: 'kanban' });
  expect(decodeURIComponent(root.querySelector('img')!.src)).toContain('<svg');
  expect(accountAvatarUrl({ ...account, serverUrl: '', user: { ...account.user!, avatarUrl: 'data:image/png;base64,YQ==' } })).toBe('data:image/png;base64,YQ==');
  expect(accountAvatarUrl({ ...account, user: { ...account.user!, avatarUrl: 'javascript:alert(1)' } })).toBeUndefined();
});

it('restores focus to the user message avatar after closing the standalone account panel', () => {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  const menu = document.createElement('div'); document.body.append(menu);
  const panel = new AccountPanel(menu, async () => {}); panel.update(account); panel.open();
  document.querySelector<HTMLButtonElement>('#close-account')!.focus();
  document.querySelector('dialog')!.dispatchEvent(new Event('close'));
  expect(document.activeElement).toBe(trigger);
});
