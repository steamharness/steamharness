import { afterEach, expect, it, vi } from 'vitest';
import { AccountPanel } from '../web/ui/account';

afterEach(() => { vi.unstubAllGlobals(); });

class Element {
  readonly events = new Map<string, () => void>();
  readonly targets = new Map<string, Element>();
  readonly children: Element[] = [];
  readonly firstElementChild = { hidden: false };
  readonly classList = { toggle: vi.fn() };
  readonly setAttribute = vi.fn();
  readonly showModal = vi.fn();
  hidden = false;
  value = '';
  src = '';
  private html = '';
  get innerHTML(): string { return this.html; }
  set innerHTML(value: string) { this.html = value; this.children.length = 0; this.firstElementChild.hidden = false; }
  addEventListener(type: string, callback: () => void): void { this.events.set(type, callback); }
  append(...children: Element[]): void { this.children.push(...children); }
  querySelector(selector: string): Element {
    if (!this.targets.has(selector)) { this.targets.set(selector, new Element()); }
    return this.targets.get(selector)!;
  }
  querySelectorAll(): Element[] { return []; }
}

function fixture(openHostAccount?: () => void) {
  const elements: Element[] = [];
  vi.stubGlobal('document', {
    body: { append: vi.fn() },
    createElement: () => {
      const element = new Element();
      elements.push(element); return element;
    },
  });
  const request = vi.fn(async () => {});
  const panel = new AccountPanel({ append: vi.fn() } as unknown as HTMLElement, request, openHostAccount);
  return { panel, request, button: elements[0], dialog: elements[1] };
}

it('both the account button and login entry open the Studio account without a separate login dialog', () => {
  const openHostAccount = vi.fn();
  const { panel, request, button, dialog } = fixture(openHostAccount);
  button.events.get('click')!();
  panel.open();
  expect(openHostAccount).toHaveBeenCalledTimes(2);
  expect(dialog.showModal).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it('a standalone Web account still opens its own login dialog', () => {
  const { button, dialog } = fixture();
  button.events.get('click')!();
  expect(dialog.showModal).toHaveBeenCalledOnce();
});

it.each(['png', 'jpeg', 'jpg', 'gif', 'webp'])('renders a Server %s data avatar in both the toolbar and account dialog', type => {
  const { panel, button, dialog } = fixture();
  const avatarUrl = `data:image/${type};base64,YXZhdGFy`;
  panel.update({ status: 'authenticated', serverUrl: 'http://127.0.0.1:7126', revision: 1,
    user: { userId: 'user', email: 'user@example.com', displayName: 'User', avatarUrl } });
  for (const avatar of [button.querySelector('.web-avatar'), dialog.querySelector('.account-avatar')]) {
    expect(avatar.children).toHaveLength(1);
    const image = avatar.children[0];
    expect(image.src).toBe(avatarUrl);
    expect(image.hidden).toBe(true);
    image.events.get('load')!();
    expect(image.hidden).toBe(false);
    expect(avatar.firstElementChild.hidden).toBe(true);
    image.events.get('error')!();
    expect(image.hidden).toBe(true);
    expect(avatar.firstElementChild.hidden).toBe(false);
  }
});

it.each(['data:text/html;base64,YXZhdGFy', 'data:image/svg+xml;base64,YXZhdGFy', 'javascript:alert(1)', 'https://user:password@example.test/avatar.png', `data:image/png;base64,${'a'.repeat(1024 * 1024)}`])('keeps the fallback for an unsupported avatar (%#)', avatarUrl => {
  const { panel, button } = fixture();
  panel.update({ status: 'authenticated', serverUrl: 'http://127.0.0.1:7126', revision: 1,
    user: { userId: 'user', email: 'user@example.com', displayName: 'User', avatarUrl } });
  expect(button.querySelector('.web-avatar').children).toHaveLength(0);
});

it('updates changed and cleared avatars while retaining relative storage URL support', () => {
  const { panel, button } = fixture();
  const user = { userId: 'user', email: 'user@example.com', displayName: 'User', avatarUrl: '/storage/avatars/user/avatar.png' as string | undefined };
  const update = () => panel.update({ status: 'authenticated', serverUrl: 'http://127.0.0.1:7126', revision: 1, user: { ...user } });
  update();
  const avatar = button.querySelector('.web-avatar');
  expect(avatar.children[0].src).toBe('http://127.0.0.1:7126/storage/avatars/user/avatar.png');
  user.avatarUrl = 'data:image/png;base64,bmV3'; update();
  expect(avatar.children).toHaveLength(1);
  expect(avatar.children[0].src).toBe(user.avatarUrl);
  user.avatarUrl = undefined; update();
  expect(avatar.children).toHaveLength(0);
  expect(avatar.firstElementChild.hidden).toBe(false);
});
