// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Fields } from '../web/ui/workflow-fields';
import type { Field, ParamValues, ParamState } from '../web/workflow-types';

vi.mock('../web/ui/parameter-actions', () => ({ ParameterActions: class { render() {} update() {} close() {} } }));
afterEach(() => document.body.replaceChildren());

function fixture(fields: Field[], values: ParamValues) {
  const root = document.createElement('div'); document.body.append(root);
  const state = { disabled: false, loading: false, fields: {} as Record<string, ParamState> };
  const options = { values: () => values, states: () => state.fields, disabled: () => state.disabled, loading: () => state.loading,
    change: vi.fn(), file: vi.fn(), pasteFile: vi.fn(), image: vi.fn(), fileUrl: (id: string) => `/entries/main/api/file/${id}?session=test` };
  const view = new Fields(root, document.createElement('div'), options); view.render({ fields });
  return { root, state, options, view };
}

it('previews single and multiple images, keeps filenames and reuses thumbnails across parameter updates', () => {
  const image = { id: 'image', name: 'diagram.png', mimeType: 'image/png' }, other = { id: 'text', name: 'notes.txt', mimeType: 'text/plain' };
  const values = { image: JSON.stringify(image), files: JSON.stringify([image, other]) };
  const f = fixture([{ name: 'image', type: 'file', accept: ['image/*'] }, { name: 'files', type: 'file', multiple: true }], values);
  const previews = f.root.querySelectorAll<HTMLButtonElement>('.param-file-preview'); expect(previews).toHaveLength(2);
  const src = '/entries/main/api/file/image?session=test'; expect(previews[0].querySelector('img')?.getAttribute('src')).toBe(src);
  previews[0].click(); expect(f.options.image).toHaveBeenCalledWith(src, 'diagram.png');
  expect(f.root.textContent).toContain('notes.txt'); f.view.update(); expect(f.root.querySelector('.param-file-preview')).toBe(previews[0]);
  values.image = ''; f.view.update(); expect(f.root.querySelector('[data-param=image] img')).toBeNull();
});

it('offers clipboard image import beside the picker only for fields accepting images and respects busy/disabled state', () => {
  const f = fixture([{ name: 'image', type: 'file', accept: ['.PNG'] }, { name: 'document', type: 'file', accept: ['application/pdf'] }, { name: 'audio', type: 'file', control: 'audio' }], {});
  const paste = f.root.querySelector<HTMLButtonElement>('.param-file-paste')!;
  expect(f.root.querySelectorAll('.param-file-paste')).toHaveLength(1);
  expect(paste.previousElementSibling?.classList.contains('param-file-button')).toBe(true);
  paste.click(); expect(f.options.pasteFile).toHaveBeenCalledExactlyOnceWith('image');
  for (const patch of [{ loading: true }, { loading: false, disabled: true }, { disabled: false, fields: { image: { disabled: true } } }]) {
    Object.assign(f.state, patch); f.view.update(); expect(paste.disabled).toBe(true);
  }
});

it('removes a thumbnail without opening its preview and clears only the selected file value', () => {
  const first = { id: 'first', name: 'first.png' }, second = { id: 'second', name: 'second.jpg' };
  const values: ParamValues = { single: JSON.stringify(first), multiple: JSON.stringify([first, second]) };
  const f = fixture([{ name: 'single', type: 'file' }, { name: 'multiple', type: 'file', multiple: true }], values);
  f.options.change.mockImplementation((name: string, value: string) => { values[name] = value; f.view.update(); });
  f.root.querySelector<HTMLButtonElement>('[data-param=single] .param-file-thumbnail > .param-file-remove')!.click();
  expect(values.single).toBe(''); expect(f.root.querySelector('[data-param=single] img')).toBeNull();
  f.root.querySelector<HTMLButtonElement>('[data-param=multiple] .param-file-thumbnail > .param-file-remove')!.click();
  expect(JSON.parse(String(values.multiple))).toEqual([second]); expect(f.options.image).not.toHaveBeenCalled();
});
