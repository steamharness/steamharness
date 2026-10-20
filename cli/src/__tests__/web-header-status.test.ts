// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';
import { updateRunningCount } from '../web/ui/history-status';

function renderPage(name: string): HTMLElement {
  const source = ts.createSourceFile(name, readFileSync(path.join(import.meta.dirname, '../web/ui', `${name}.ts`), 'utf8'), ts.ScriptTarget.Latest, true);
  let template: ts.TemplateExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left) && node.left.expression.getText(source) === 'app'
      && node.left.name.text === 'innerHTML' && ts.isTemplateExpression(node.right)) { template = node.right; }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!template) { throw new Error(`Missing ${name} page template`); }
  // Interpolations contain labels and icons; the literal fragments define the layout.
  document.body.innerHTML = `<div id="app">${template.head.text}${template.templateSpans.map(span => span.literal.text).join('')}</div>`;
  const style = document.createElement('style');
  style.textContent = readFileSync(path.join(import.meta.dirname, '../web/ui/style.css'), 'utf8'); document.head.append(style);
  return document.querySelector<HTMLElement>('#app')!;
}

afterEach(() => { document.body.replaceChildren(); document.head.replaceChildren(); });

it.each(['main', 'workflow-main'])('keeps the %s running count in the page header when the sidebar is hidden', name => {
  const app = renderPage(name), counter = app.querySelector<HTMLElement>('#running-count')!;
  const toolbar = app.querySelector<HTMLElement>('header.toolbar')!, sidebar = app.querySelector<HTMLElement>('#project-menu')!;
  expect(app.querySelectorAll('#running-count')).toHaveLength(1);
  expect(counter.parentElement).toBe(toolbar.querySelector('.toolbar-actions'));
  expect(sidebar.contains(counter)).toBe(false);
  updateRunningCount(counter, 2, 'Running: 2');
  const glyph = counter.firstElementChild;
  for (const open of [true, false, true]) {
    app.classList.toggle('menu-open', open);
    sidebar.hidden = !open;
    expect(counter.closest('[hidden]')).toBeNull();
    expect(getComputedStyle(counter).display).toBe('inline-flex');
    expect(getComputedStyle(counter).flexShrink).toBe('0');
    expect(getComputedStyle(counter).height).toBe('28px');
    expect(counter.textContent).toBe('2'); expect(counter.firstElementChild).toBe(glyph);
  }
  updateRunningCount(counter, 0, 'Running: 0'); expect(counter.hidden).toBe(true);
});
