// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { FileIcons } from '../web/ui/file-icons';

const controllers: FileIcons[] = [];
afterEach(() => { controllers.splice(0).forEach(icons => icons.dispose()); vi.useRealTimers(); document.body.replaceChildren(); });
const font = { id: 'sh-file-icon-0-0', src: 'data:font/woff2;base64,d29mMg==', format: 'woff2', weight: 'normal', style: 'normal' };
const ts = { path: '/src/index.ts', kind: 'file', glyph: '\u02a6', color: '#6a9fb5', size: '100%', font: font.id };
function fixture() {
  vi.useFakeTimers(); const post = vi.fn(), icons = new FileIcons(post); controllers.push(icons);
  const bind = (path = ts.path, kind: 'file' | 'directory' = 'file') => {
    const element = document.createElement('span'); document.body.append(element); icons.bind(element, path, kind); return element;
  };
  const enable = (enabled = true) => icons.receive({ type: 'file-icons-changed', enabled });
  const flush = () => vi.advanceTimersByTime(16);
  const reply = (requestId: string, resources: unknown[] = [ts], fonts: unknown[] = [font]) => icons.receive({ type: 'file-icons', requestId, icons: resources, fonts });
  return { icons, post, bind, enable, flush, reply };
}

it('uses neutral offline fallbacks and batches unique connected resources only after Studio advertises the theme', () => {
  const f = fixture(), file = f.bind(), folder = f.bind('/node_modules', 'directory'); f.bind(); f.bind('/removed').remove();
  expect(file.querySelector('.codicon-file')).not.toBeNull(); expect(folder.querySelector('.codicon-folder')).not.toBeNull();
  f.flush(); expect(f.post).not.toHaveBeenCalled();
  f.enable(); f.flush();
  expect(f.post).toHaveBeenCalledOnce(); expect(f.post.mock.calls[0][0].files).toEqual([{ path: ts.path, kind: 'file' }, { path: '/node_modules', kind: 'directory' }]);
  f.bind(); f.flush(); expect(f.post).toHaveBeenCalledOnce();
});

it('renders the host theme glyph, font and color across duplicate cards and reuses fonts and cached icons', () => {
  const f = fixture(), first = f.bind(), second = f.bind(); f.enable(); f.flush();
  const request = f.post.mock.calls[0][0]; f.reply(request.requestId);
  for (const element of [first, second]) {
    expect(element.textContent).toBe('\u02a6'); expect(element.style.fontFamily).toContain(font.id);
    expect(element.style.color).toBe('rgb(106, 159, 181)'); expect(element.style.fontSize).toBe('100%');
  }
  const style = document.head.querySelector('style')!; expect(style.textContent).toContain(font.src);
  expect(f.bind().textContent).toBe(ts.glyph); f.flush(); expect(f.post).toHaveBeenCalledOnce();
  f.enable(); f.flush(); f.reply(f.post.mock.calls[1][0].requestId);
  expect(document.head.querySelectorAll('style')).toHaveLength(1);
  f.icons.dispose(); expect(style.isConnected).toBe(false);
});

it('retains existing icons during a theme refresh and ignores obsolete or unsolicited responses', () => {
  const f = fixture(), element = f.bind(); f.enable(); f.flush(); const old = f.post.mock.calls[0][0];
  f.reply('foreign'); expect(element.querySelector('.codicon-file')).not.toBeNull();
  f.reply(old.requestId); expect(element.textContent).toBe(ts.glyph);
  f.enable(); expect(element.textContent).toBe(ts.glyph); expect(f.bind().textContent).toBe(ts.glyph); f.flush();
  const current = f.post.mock.calls[1][0]; f.enable(); f.reply(current.requestId, [{ ...ts, glyph: 'stale' }]);
  expect(element.textContent).toBe(ts.glyph); f.flush();
  f.reply(f.post.mock.calls[2][0].requestId, [{ ...ts, glyph: '\ue91c', color: '#ac4142' }]);
  expect(element.textContent).toBe('\ue91c'); expect(element.style.color).toBe('rgb(172, 65, 66)');
  f.enable(false); f.flush(); expect(element.querySelector('.codicon-file')).not.toBeNull();
});

it('supports image and current-color mask themes and rejects untrusted CSS or resource URLs', () => {
  const f = fixture(), image = f.bind('/logo.svg'), mask = f.bind('/folder', 'directory'), unsafe = f.bind('/unsafe'); f.enable(); f.flush();
  const src = 'data:image/svg+xml;base64,PHN2Zy8+';
  f.reply(f.post.mock.calls[0][0].requestId, [
    { path: '/logo.svg', kind: 'file', image: src }, { path: '/folder', kind: 'directory', image: src, mask: true },
    { path: '/unsafe', kind: 'file', image: 'https://example.com/icon.svg', glyph: '<script>', font: 'bad";}', color: 'url(https://example.com)', size: '99px;display:none' },
  ], [{ ...font, src: 'https://example.com/font.woff2' }]);
  expect(image.querySelector('img')?.src).toBe(src); expect(mask.querySelector<HTMLElement>('.file-theme-mask')?.style.maskImage).toContain(src);
  expect(unsafe.querySelector('.codicon-file')).not.toBeNull(); expect(unsafe.getAttribute('style')).toBeNull(); expect(document.head.querySelector('style')).toBeNull();
});

it('bounds request batches, handles missing definitions, and releases removed cards and pending work', () => {
  const f = fixture(); for (let i = 0; i < 70; i++) f.bind(`/file-${i}`); f.enable(); f.flush();
  expect(f.post.mock.calls.map(([request]) => request.files.length)).toEqual([32, 32, 6]);
  const removed = document.body.firstElementChild!; removed.remove();
  f.reply(f.post.mock.calls[0][0].requestId, [], []);
  expect(document.body.querySelectorAll('.codicon-file')).toHaveLength(69);
  f.enable(); f.icons.dispose(); f.flush(); expect(f.post).toHaveBeenCalledTimes(3);
  expect(f.icons.receive({ type: 'file-icons-changed', enabled: true })).toBe(false);
});
