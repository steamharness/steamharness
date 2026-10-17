import { afterEach, expect, it, vi } from 'vitest';
import { AccountPanel } from '../web/ui/account';

afterEach(() => { vi.unstubAllGlobals(); });

function fixture(openHostAccount?: () => void) {
  const elements: { events: Map<string, () => void>; showModal: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('document', {
    body: { append: vi.fn() },
    createElement: () => {
      const events = new Map<string, () => void>();
      const element = {
        events, setAttribute: vi.fn(), showModal: vi.fn(),
        addEventListener: (type: string, callback: () => void) => events.set(type, callback),
        querySelector: () => ({ addEventListener: vi.fn() }),
      };
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
