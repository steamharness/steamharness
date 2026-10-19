import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import type { InputRequest } from '../web/workflow-types';

class Element {
  children: Element[] = [];
  textContent = '';
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  addEventListener() {}
  querySelectorAll() { return []; }
  setAttribute() {}
  get text(): string { return [this.textContent, ...this.children.map(child => child.text)].join(' '); }
}

it('shows both single-file and multiple-file defaults in a restored input request', async () => {
  const compiled = await build({ entryPoints: ['src/web/ui/input-prompt.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = { exports: {} as { InputPrompt: new (request: InputRequest, options: object) => { root: Element } } };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports,
    document: { createElement: () => new Element() }, HTMLInputElement: Element, HTMLTextAreaElement: Element,
  });
  const prompt = new module.exports.InputPrompt({ requestId: 'file-request', nodeName: 'input', title: 'Files',
    params: [{ name: 'file', type: 'file' }, { name: 'files', type: 'file', multiple: true }],
    defaultValues: { file: { id: 'single', name: 'single.txt' }, files: [{ id: 'multiple', name: 'multiple.txt' }] },
  }, { submit() {}, stop() {} });
  expect(prompt.root.text).toContain('single.txt'); expect(prompt.root.text).toContain('multiple.txt');
});
