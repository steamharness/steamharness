// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotArtifactLibrary } from '../web/ui/bot-artifacts';

const record = { id: 'ba_0123456789abcdef0123456789abcdef', title: 'Release report', name: 'report.md', size: 10, createdAt: '2026-11-24T01:02:00Z', preview: 'text', conversationId: 'source' };

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } });
  document.head.innerHTML = '<meta name="steamharness-base" content="/entries/assistant">';
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear(); document.body.replaceChildren(); document.head.replaceChildren(); });

it('refreshes an existing card when another window removes a snapshot', async () => {
  let removed = false;
  vi.stubGlobal('fetch', vi.fn(async () => removed ? new Response('', { status: 404 }) : Response.json(record)));
  const library = new BotArtifactLibrary({ navigate: vi.fn() });
  library.configure('ready', 'Bot instance', 0);
  const card = library.card({ title: 'Report', content: record }); document.body.append(card);
  const actions = card.querySelector<HTMLElement>('.bot-artifact-actions')!;
  await expect.poll(() => actions.hidden).toBe(false);
  removed = true;
  library.configure('ready', 'Bot instance', 1);
  await expect.poll(() => actions.hidden).toBe(true);
  expect(card.textContent).toContain('Artifact removed');
});

it('pages only delivered files, previews text without rendering markup, and can open its source', async () => {
  const navigate = vi.fn();
  const second = { ...record, title: 'Older', id: 'ba_1123456789abcdef0123456789abcdef', conversationId: undefined };
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes('preview=1')) return new Response('<script>not a page</script>');
    if (url.endsWith(record.id)) return Response.json(record);
    if (url.endsWith('?before=12')) return Response.json({ artifacts: [second] });
    return Response.json({ artifacts: [record], nextBefore: 12 });
  });
  vi.stubGlobal('fetch', fetch);
  sessionStorage.setItem('steamharness-web-session', 'fixture-session');
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:fixture'; } static revokeObjectURL() {} });
  const library = new BotArtifactLibrary({ navigate });
  library.configure('ready', 'Bot instance: Copy');
  library.open();
  const modal = document.querySelector<HTMLDialogElement>('.bot-artifact-library')!;
  await expect.poll(() => modal.querySelector('.bot-artifact-list')?.textContent).toContain('Release report');
  expect(modal.textContent).toContain('Bot instance: Copy');
  modal.querySelector<HTMLButtonElement>('.bot-artifact-more')!.click();
  await expect.poll(() => modal.querySelectorAll('.bot-artifact-row').length).toBe(2);
  modal.querySelector<HTMLButtonElement>('.bot-artifact-row button[aria-label="Download"]')!.click();
  await expect.poll(() => download.mock.calls.length).toBe(1);
  const [downloadUrl, init] = fetch.mock.calls.find(([url]) => url.endsWith(`/${record.id}/content`))!;
  expect(downloadUrl).toBe(`/entries/assistant/api/bot-artifacts/${record.id}/content`);
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-session');
  expect((download.mock.contexts[0] as HTMLAnchorElement).download).toBe('report.md');
  modal.querySelector<HTMLButtonElement>('.bot-artifact-row button[aria-label="Open artifact"]')!.click();
  await expect.poll(() => modal.querySelector('.bot-artifact-preview pre')?.textContent).toBe('<script>not a page</script>');
  expect(modal.querySelector('.bot-artifact-preview script')).toBeNull();
  expect(modal.querySelectorAll<HTMLButtonElement>('button[aria-label="Open source conversation"]')[1]?.disabled).toBe(true);
  modal.querySelector<HTMLButtonElement>('button[aria-label="Open source conversation"]')!.click();
  expect(navigate).toHaveBeenCalledWith(record.conversationId, record.id);
  expect(modal.open).toBe(false);
});

it('confirms removal and changes the existing conversation card to removed', async () => {
  let removed = false;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') { removed = true; return Response.json({ removed }); }
    if (url.endsWith(record.id)) return removed ? new Response(null, { status: 404 }) : Response.json(record);
    return Response.json({ artifacts: removed ? [] : [record] });
  });
  vi.stubGlobal('fetch', fetch);
  const library = new BotArtifactLibrary({ navigate: vi.fn() });
  library.configure('ready', 'Original Bot: Fixture');
  const card = library.card({ title: record.title, content: record });
  document.body.append(card);
  library.open();
  await expect.poll(() => document.querySelector('.bot-artifact-row')?.textContent).toContain(record.title);
  document.querySelector<HTMLButtonElement>('.bot-artifact-row button[aria-label="Remove delivery"]')!.click();
  expect(removed).toBe(false);
  document.querySelector<HTMLFormElement>('.action-dialog form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await expect.poll(() => card.textContent).toContain('Artifact removed');
  expect(card.querySelector<HTMLElement>('.bot-artifact-actions')?.hidden).toBe(true);
  expect(library.card({ title: record.title, content: record }, false).hidden).toBe(true);
});
