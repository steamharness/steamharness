import { getDocument, PDFWorker, PasswordResponses, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { t } from '../localization';
import { element, pager, zoom, rememberScroll, previewWorker, type PreviewRenderer } from './view';

const render: PreviewRenderer = async (bytes, context, signal, name) => {
  const viewport = element('div', 'preview-scroll preview-pdf'), pages = element('div'); viewport.append(pages);
  const tools = element('div');
  const resource = await previewWorker('./pdf/pdf.worker.min.mjs', signal);
  // PDF.js types infer `port` as null; its runtime accepts a Worker.
  const worker = new PDFWorker({ port: resource.worker } as unknown as ConstructorParameters<typeof PDFWorker>[0]);
  const base = new URL('./pdf/', import.meta.url).href;
  const loading = getDocument({ data: bytes.slice(), cMapUrl: `${base}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, worker });
  let disposed = false, pdf: PDFDocumentProxy | undefined, resize: ResizeObserver | undefined, visible: IntersectionObserver | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined, renderedWidth = 0;
  const tasks = new Set<{ cancel(): void }>();
  let forgetScroll = (): void => {};
  const dispose = (): void => {
    if (disposed) { return; } disposed = true; clearTimeout(resizeTimer); forgetScroll(); resize?.disconnect(); visible?.disconnect(); for (const task of tasks) { task.cancel(); }
    void loading.destroy().catch(() => undefined).finally(() => { worker.destroy(); resource.dispose(); });
  };
  signal.addEventListener('abort', dispose, { once: true });
  const password = element('form', 'preview-password');
  let showPassword!: () => void;
  const passwordReady = new Promise<void>(resolve => { showPassword = resolve; });
  loading.onPassword = (update: (password: string) => void, reason: number) => {
    const label = element('label', '', t('PDF password')), input = element('input'); input.type = 'password'; input.autocomplete = 'off';
    const submit = element('button', '', t('Unlock')); submit.type = 'submit'; label.append(input);
    password.replaceChildren(label, submit);
    if (reason === PasswordResponses.INCORRECT_PASSWORD) { password.append(element('span', 'formula-error', t('Incorrect PDF password.'))); }
    password.onsubmit = event => { event.preventDefault(); if (input.value) { update(input.value); input.value = ''; } };
    viewport.replaceChildren(password);
    showPassword();
  };
  const painted = new Map<HTMLElement, number>();
  let renderRevision = 0;
  const paint = async (page: HTMLElement): Promise<void> => {
    if (!pdf || disposed || painted.get(page) === renderRevision) { return; }
    const revision = renderRevision; painted.set(page, revision);
    const proxy = await pdf.getPage(Number(page.dataset.page));
    if (disposed || revision !== renderRevision) { return; }
    const original = proxy.getViewport({ scale: 1 });
    const scale = context.state.fit ? Math.min(4, Math.max(0.1, (context.width() - 32) / original.width)) : context.state.scale;
    const size = proxy.getViewport({ scale });
    const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16_000_000 / (size.width * size.height)));
    const canvas = element('canvas'); canvas.width = Math.ceil(size.width * ratio); canvas.height = Math.ceil(size.height * ratio);
    canvas.style.width = `${size.width}px`; canvas.style.height = `${size.height}px`; canvas.ariaLabel = `${name}: ${page.dataset.page}`;
    page.style.width = `${size.width}px`; page.style.height = `${size.height}px`;
    page.style.setProperty('--scale-factor', String(scale)); page.style.setProperty('--total-scale-factor', String(scale));
    const text = element('div', 'textLayer');
    const task = proxy.render({ canvas, viewport: size, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }); tasks.add(task);
    const textTask = new TextLayer({ textContentSource: proxy.streamTextContent(), container: text, viewport: size }); tasks.add(textTask);
    try {
      await Promise.all([task.promise, textTask.render()]);
      if (!disposed && revision === renderRevision) { page.replaceChildren(canvas, text); }
    } finally { tasks.delete(task); tasks.delete(textTask); }
  };
  const rebuild = (): void => {
    clearTimeout(resizeTimer); resizeTimer = undefined;
    if (!pdf || disposed) { return; }
    renderedWidth = viewport.clientWidth;
    ++renderRevision; for (const task of tasks) { task.cancel(); } painted.clear();
    visible?.disconnect();
    visible = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) { void paint(entry.target as HTMLElement).catch(error => { if (!disposed && error?.name !== 'RenderingCancelledException' && error?.name !== 'AbortException') { context.error(error); } }); }
      }
    }, { root: viewport, rootMargin: '600px 0px' });
    for (const page of Array.from(pages.children) as HTMLElement[]) { visible.observe(page); }
  };
  const loaded = loading.promise.then(async document => {
    if (disposed) { return; }
    pdf = document; context.state.page = Math.min(context.state.page, pdf.numPages);
    const first = await pdf.getPage(1), size = first.getViewport({ scale: 1 });
    if (disposed) { return; }
    const scale = context.state.fit ? Math.min(4, Math.max(0.1, (context.width() - 32) / size.width)) : context.state.scale;
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = element('div', 'preview-page'); page.dataset.page = String(index);
      page.style.width = `${size.width * scale}px`; page.style.height = `${size.height * scale}px`; pages.append(page);
    }
    viewport.replaceChildren(pages);
    tools.replaceChildren(pager(context, pdf.numPages, page => {
      const target = pages.children[page - 1] as HTMLElement; viewport.scrollTop = target.offsetTop - 16;
    }), zoom(context, rebuild));
    activate();
  });
  let active = false;
  viewport.addEventListener('scroll', () => {
    if (!pdf || disposed) { return; }
    const top = viewport.scrollTop + viewport.clientHeight * 0.25;
    let page = 1;
    for (const node of Array.from(pages.children) as HTMLElement[]) { if (node.offsetTop <= top) { page = Number(node.dataset.page); } else { break; } }
    if (context.state.page !== page) { context.state.page = page; context.save(); tools.querySelector('.preview-pager')?.dispatchEvent(new Event('preview-page-change')); }
  });
  const activate = (): void => {
    if (!active || !pdf || disposed) { return; }
    forgetScroll(); forgetScroll = rememberScroll(viewport, context); rebuild();
    resize?.disconnect(); resize = new ResizeObserver(() => {
      if (!context.state.fit || viewport.clientWidth <= 0 || viewport.clientWidth === renderedWidth) {
        clearTimeout(resizeTimer); resizeTimer = undefined; return;
      }
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(rebuild, 150);
    }); resize.observe(viewport);
    if (context.state.top === 0 && context.state.page > 1) { viewport.scrollTop = (pages.children[context.state.page - 1] as HTMLElement).offsetTop - 16; }
  };
  void loaded.catch(error => { if (!disposed && active) { context.error(error); } });
  try { await Promise.race([loaded, passwordReady]); signal.throwIfAborted(); }
  catch (error) { dispose(); throw error; }
  return { element: viewport, tools, activate: () => { active = true; activate(); }, dispose };
};
export default render;
