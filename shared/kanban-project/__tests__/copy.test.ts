import { afterEach, expect, it, vi } from 'vitest';
import { installProjectCopyBridge } from '../copy';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); document.body.replaceChildren(); window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); });

function fixture() {
  document.body.innerHTML = '<p>正文与引用\n第二行</p><button>可选择的按钮文字</button><textarea></textarea><input type="password" value="private">';
  const writeText = vi.fn(async (_text: string) => true), contextMenu = vi.fn();
  const bridge = installProjectCopyBridge(window, { enabled: () => true, writeText, contextMenu }); cleanup.push(bridge.dispose);
  const select = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); };
  return { bridge, writeText, contextMenu, select };
}

it('copies readonly selections and honors editor-specific serialization without a browser clipboard', async () => {
  const f = fixture(); f.select(document.querySelector('p')!);
  expect(f.bridge.command('copy')).toBe(true);
  await vi.waitFor(() => expect(f.writeText).toHaveBeenCalledWith('正文与引用\n第二行'));
  const input = document.querySelector('textarea')!; input.value = '@file:short.ts'; input.focus(); input.select();
  input.addEventListener('copy', event => { event.preventDefault(); event.clipboardData!.setData('text/plain', '@file:/project/short.ts'); });
  f.bridge.command('copy');
  await vi.waitFor(() => expect(f.writeText).toHaveBeenLastCalledWith('@file:/project/short.ts'));
  expect(input.value).toBe('@file:short.ts'); expect(input.selectionStart).toBe(0);
});

it('handles a copy event and preserves the context selection when menu focus changes', async () => {
  const f = fixture(); const text = document.querySelector('p')!; f.select(text);
  const copy = new Event('copy', { bubbles: true, cancelable: true }); text.dispatchEvent(copy);
  expect(copy.defaultPrevented).toBe(true);
  text.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 34 }));
  expect(f.contextMenu).toHaveBeenCalledWith({ x: 12, y: 34, selection: true, editable: false });
  window.getSelection()?.removeAllRanges(); f.bridge.command('copy', true);
  await vi.waitFor(() => expect(f.writeText).toHaveBeenCalledTimes(2));
  expect(f.writeText).toHaveBeenLastCalledWith('正文与引用\n第二行');
});

it('does not navigate buttons after a selection drag, while preserving normal clicks', () => {
  const f = fixture(), button = document.querySelector('button')!, click = vi.fn(); button.addEventListener('click', click);
  const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 2, clientY: 3 }); button.dispatchEvent(down);
  f.select(button); button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: 40, clientY: 3 }));
  expect(click).not.toHaveBeenCalled();
  button.dispatchEvent(down); button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 2, clientY: 3 }));
  expect(click).toHaveBeenCalledOnce();
});

it('selects readonly text, excludes passwords, and delegates focused child frames', () => {
  const f = fixture(), input = document.querySelector('textarea')!; input.value = '可复制的设置'; input.readOnly = true; input.focus();
  f.bridge.command('selectAll'); expect(input.selectionEnd).toBe(input.value.length);
  const password = document.querySelector('input')!; password.focus(); password.select();
  expect(f.bridge.command('copy')).toBe(false); expect(f.writeText).not.toHaveBeenCalled();
  const delegate = vi.fn(() => true), writeText = vi.fn(async () => true);
  const nested = installProjectCopyBridge(window, { enabled: () => true, writeText, delegate }); cleanup.push(nested.dispose);
  expect(nested.command('copy', true)).toBe(true); expect(delegate).toHaveBeenCalledWith('copy', true, undefined); expect(writeText).not.toHaveBeenCalled();
});

it('keeps browser copy native without a host and survives serialized installation', () => {
  const f = fixture(); f.bridge.dispose();
  const build = new Function('return (' + installProjectCopyBridge.toString() + ')')() as typeof installProjectCopyBridge;
  const bridge = build(window, { enabled: () => false, writeText: f.writeText }); cleanup.push(bridge.dispose);
  f.select(document.querySelector('p')!); const event = new Event('copy', { bubbles: true, cancelable: true }); document.body.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false); expect(f.writeText).not.toHaveBeenCalled();
  bridge.command('copy'); expect(f.writeText).toHaveBeenCalledOnce();
});

it('cuts only after a confirmed write and leaves changed or readonly inputs intact', async () => {
  const f = fixture(), input = document.querySelector('textarea')!;
  const original = document.execCommand, execute = vi.fn(() => true); document.execCommand = execute;
  cleanup.push(() => { document.execCommand = original; });
  input.value = '保留的内容'; input.focus(); input.select();
  f.writeText.mockResolvedValueOnce(false); f.bridge.command('cut');
  await vi.waitFor(() => expect(f.writeText).toHaveBeenCalledOnce());
  expect(execute).not.toHaveBeenCalled();
  let confirm!: (value: boolean) => void;
  f.writeText.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  f.bridge.command('cut'); input.value = '用户已经修改'; confirm(true);
  await Promise.resolve(); await Promise.resolve(); expect(execute).not.toHaveBeenCalled();
  input.readOnly = true; expect(f.bridge.command('paste', false, { text: '不能覆盖' })).toBe(false);
  input.readOnly = false; f.bridge.command('paste', false, { text: '粘贴内容' });
  expect(execute).toHaveBeenCalledWith('insertText', false, '粘贴内容');
});
