// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { bindOutputFileLinks, fileLinkTarget } from '../web/ui/output-file-links';
import { markdownHtml } from '../web/ui/ui';

afterEach(() => { document.body.replaceChildren(); window.getSelection()?.removeAllRanges(); });

it.each([
  ['configuration.json', { path: 'configuration.json' }],
  ['../src/main.ts:12:3', { path: '../src/main.ts', line: 12, column: 3 }],
  ['configuration.json:12', { path: 'configuration.json', line: 12 }],
  ['/work/a%20b/%E6%8A%A5%E5%91%8A.md#L24C5', { path: '/work/a b/报告.md', line: 24, column: 5 }],
  ['file:///work/a%20b%23c.md#L4-L8', { path: '/work/a b#c.md', line: 4 }],
  ['file://localhost/tmp/a.txt', { path: '/tmp/a.txt' }],
  ['C:\\Work\\main.ts:19:2', { path: 'C:\\Work\\main.ts', line: 19, column: 2 }],
  ['file:///C:/Work/a%20b.ts#L8', { path: 'C:/Work/a b.ts', line: 8 }],
  ['\\\\server\\share\\a.txt', { path: '\\\\server\\share\\a.txt' }],
  ['file://server/share/a%20b.txt', { path: '\\\\server\\share\\a b.txt' }],
] as const)('interprets local link %s without the page origin', (href, expected) => {
  expect(fileLinkTarget(href)).toEqual(expected);
});

it.each([
  '', '#section', '?tab=files', 'https://example.com/a.ts#L2', '//example.com/a.ts', 'mailto:user@example.com',
  'command:workbench.action.closeWindow', 'javascript:1', 'javascript:alert(1)', 'data:text/html,hello',
  'vscode://file/tmp/a.ts', 'javascript%3Aalert(1)', 'file:///tmp/a.ts?download=1', '/tmp/%00file', '/tmp/a\nfile',
  '/tmp/bad%escape', '/tmp/a.ts:0', '/tmp/a.ts:1:0', '/tmp/a.ts#L9007199254740992', '/'.repeat(4097),
])('does not treat %s as an editor file link', href => { expect(fileLinkTarget(href)).toBeUndefined(); });

it('retains sanitized file URI targets, opens managed attachments first, and keeps Web links external', () => {
  const root = document.createElement('div'), file = vi.fn(), path = vi.fn(); document.body.append(root);
  root.innerHTML = markdownHtml('[config](file:///work/a%20b.json#L2C4) [managed](/work/attachment.pdf) [web](https://example.com/a.ts) [bad](javascript:alert%281%29)', [
    { id: 'wf_' + 'a'.repeat(32), path: '/work/attachment.pdf', name: 'attachment.pdf', mimeType: 'application/pdf',
      size: 1, kind: 'file', storage: 'local', createdAt: '', previewUrl: '/api/file/attachment' },
  ]);
  bindOutputFileLinks(root, { file, path });
  const [local, managed, web, bad] = Array.from(root.querySelectorAll('a'));
  expect(local.hasAttribute('href')).toBe(true); local.click();
  expect(path).toHaveBeenLastCalledWith({ path: '/work/a b.json', line: 2, column: 4 });
  managed.click(); expect(file).toHaveBeenCalledWith('wf_' + 'a'.repeat(32)); expect(path).toHaveBeenCalledOnce();
  expect(web.target).toBe('_blank'); expect(web.rel).toBe('noopener noreferrer'); expect(bad.getAttribute('href')).toBeNull();
  expect(root.querySelector('script')).toBeNull();
});

it('links inline filenames and plain absolute paths while preserving code blocks, nested links and copied text', () => {
  const text = '`configuration.json` and `src/main.ts:12:3` and `C:\\Work\\a b.ts`\n\nFile: /work/main.ts:4, 报告 /work/报告.md。\n\n`npm run build`\n\n```sh\ncat /work/main.ts\n```\n\n[already linked `src/main.ts`](/work/main.ts)';
  const root = document.createElement('div'), file = vi.fn(), path = vi.fn(); document.body.append(root);
  root.innerHTML = markdownHtml(text); const original = root.textContent;
  bindOutputFileLinks(root, { file, path });
  expect(root.textContent).toBe(original); expect(root.querySelectorAll('a a')).toHaveLength(0);
  expect(root.querySelector('pre a')).toBeNull(); expect(root.querySelectorAll('a')).toHaveLength(6);
  root.querySelectorAll('a')[1].click(); expect(path).toHaveBeenLastCalledWith({ path: 'src/main.ts', line: 12, column: 3 });
  root.querySelectorAll('a')[2].click(); expect(path).toHaveBeenLastCalledWith({ path: 'C:\\Work\\a b.ts' });
  root.querySelectorAll('a')[3].click(); expect(path).toHaveBeenLastCalledWith({ path: '/work/main.ts', line: 4 });
  root.querySelectorAll('a')[4].click(); expect(path).toHaveBeenLastCalledWith({ path: '/work/报告.md' });
  const link = root.querySelector('a')!, selection = window.getSelection()!;
  const range = document.createRange(); range.selectNodeContents(link); selection.addRange(range);
  path.mockClear(); link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })); expect(path).not.toHaveBeenCalled();
  selection.removeAllRanges(); link.click(); expect(path).toHaveBeenCalledWith({ path: 'configuration.json' });
});

it('keeps Markdown rendering reusable by consumers without an editor callback', () => {
  const root = document.createElement('div'); root.innerHTML = markdownHtml('`configuration.json` [file](./configuration.json)');
  bindOutputFileLinks(root, { file() {} });
  expect(root.querySelectorAll('a')).toHaveLength(1); expect(root.querySelector('a')?.target).toBe('_blank');
});
