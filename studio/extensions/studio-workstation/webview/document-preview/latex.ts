import katex from 'katex';
import renderMathInElement from 'katex/contrib/auto-render';
import 'katex/dist/katex.min.css';
import { t } from '../localization';
import { element, rememberScroll, type PreviewRenderer } from './view';

const render: PreviewRenderer = async (bytes, context, signal) => {
  signal.throwIfAborted();
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes), root = element('div'); root.textContent = source;
  const errors: string[] = [];
  renderMathInElement(root, {
    delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false },
      ...['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'alignat', 'alignat*'].map(environment => ({ left: `\\begin{${environment}}`, right: `\\end{${environment}}`, display: true })),
      { left: '$', right: '$', display: false }], trust: false, maxExpand: 1000, strict: 'ignore', throwOnError: true,
    errorCallback: (_message, error) => errors.push(error.message),
  });
  const formulas = Array.from(root.querySelectorAll<HTMLElement>('.katex-display, .katex')).filter(node => !node.parentElement?.closest('.katex-display, .katex'));
  if (!formulas.length && !errors.length && source.trim() && !/\\(?:documentclass|begin\{document\})/.test(source)) {
    const formula = element('div');
    try { katex.render(source, formula, { displayMode: true, trust: false, maxExpand: 1000, strict: 'ignore' }); formulas.push(formula); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  const viewport = element('div', 'preview-scroll preview-formulas');
  for (const formula of formulas) { const block = element('div', 'formula'); block.append(formula); viewport.append(block); }
  if (!formulas.length && !errors.length) { viewport.append(element('p', '', t('No formulas found.'))); }
  for (const error of errors) { viewport.append(element('pre', 'formula-error', t('Formula error: {0}', error))); }
  let forgetScroll = (): void => {};
  return { element: viewport, activate: () => { forgetScroll = rememberScroll(viewport, context); }, dispose: () => forgetScroll() };
};
export default render;
