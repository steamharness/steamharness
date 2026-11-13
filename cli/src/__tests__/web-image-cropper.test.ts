// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cropImageFile, fileSelectionOptions, prepareImageFiles } from '../web/ui/image-cropper';

const dialogDescriptors = Object.fromEntries(['showModal', 'close'].map(name => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)]));
afterEach(() => {
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [name, descriptor] of Object.entries(dialogDescriptors)) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

it('keeps cropping disabled unless explicitly declared and forwards image settings with file metadata', async () => {
  const file = new File(['original'], 'photo.png', { type: 'image/png' }), files = [file];
  expect(await prepareImageFiles(files)).toBe(files);
  expect(await prepareImageFiles(files, { crop: false })).toBe(files);
  const image = { crop: true, minWidth: 280, maxWidth: 1568 };
  expect(fileSelectionOptions({ name: 'photo', type: 'file', accept: ['image/png'], multiple: false, image })).toEqual({ accept: ['image/png'], multiple: false, image });
});

it('Escape cancels the edit, releases the object URL, and restores focus without returning a file', async () => {
  const button = document.createElement('button'); document.body.append(button); button.focus();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:crop-test');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event('close')); } },
  });
  const pending = cropImageFile(new File(['image'], 'photo.png', { type: 'image/png' }), { crop: true });
  const dialog = document.querySelector('dialog')!;
  expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(await pending).toBeUndefined();
  expect(revoke).toHaveBeenCalledWith('blob:crop-test');
  expect(document.querySelector('dialog')).toBeNull();
  expect(document.activeElement).toBe(button);
});
