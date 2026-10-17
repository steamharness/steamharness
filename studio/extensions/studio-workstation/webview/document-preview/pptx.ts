import { PPTXViewer } from 'pptxviewjs';
import { t } from '../localization';
import { element, pager, button, rememberScroll, type PreviewRenderer } from './view';

interface SlideProcessor {
  getSlideDimensions(): { cx: number; cy: number };
  getCurrentSlide(index: number): { partUri: string } | null;
  processor: {
    processShapeTree(element: Element): unknown[];
    package: { getPartByUri(path: string): { getDocumentContent(): Promise<string | null> } | null };
  };
}

const drawingml = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function compatibleShapeTree(element: Element): Element {
  const tree = element.cloneNode(true) as Element;
  // Some producers append /table to the main namespace; pptxviewjs expects the table URI.
  for (const graphic of tree.getElementsByTagNameNS(drawingml, 'graphicData')) {
    if (graphic.getAttribute('uri') === `${drawingml}/table` &&
      Array.from(graphic.children).some(child => child.namespaceURI === drawingml && child.localName === 'tbl')) {
      graphic.setAttribute('uri', 'http://schemas.openxmlformats.org/drawingml/2006/table');
    }
  }
  // Both the shape and table parsers only read the Latin font, even for East Asian runs.
  for (const run of tree.getElementsByTagNameNS(drawingml, 'r')) {
    const text = run.getElementsByTagNameNS(drawingml, 't')[0]?.textContent ?? '';
    if (!/[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(text)) { continue; }
    const properties = run.getElementsByTagNameNS(drawingml, 'rPr')[0];
    if (!properties) { continue; }
    const typeface = properties.getElementsByTagNameNS(drawingml, 'ea')[0]?.getAttribute('typeface');
    if (!typeface || typeface.startsWith('+')) { continue; }
    let latin = properties.getElementsByTagNameNS(drawingml, 'latin')[0];
    if (!latin) {
      latin = tree.ownerDocument.createElementNS(drawingml, `${properties.prefix ? `${properties.prefix}:` : ''}latin`);
      properties.append(latin);
    }
    latin.setAttribute('typeface', typeface);
  }
  return tree;
}

const render: PreviewRenderer = async (bytes, context, signal, name) => {
  const viewport = element('div', 'preview-scroll preview-slide'), canvas = element('canvas'); canvas.ariaLabel = name;
  const viewer = new PPTXViewer({ canvas, enableThumbnails: false, debug: false, autoChartRerenderDelayMs: 0 });
  let disposed = false, revision = 0, queue = Promise.resolve(), text = '';
  let resizeTimer: ReturnType<typeof setTimeout> | undefined, observedWidth = 0, observedHeight = 0;
  let fonts: FontFace[] = [];
  let forgetScroll = (): void => {};
  const processor = (): SlideProcessor => (viewer as unknown as { processor: SlideProcessor }).processor;
  viewer.on('processorReady', () => {
    const core = processor().processor, process = core.processShapeTree;
    core.processShapeTree = function (tree) { return process.call(this, compatibleShapeTree(tree)); };
  });
  viewport.append(canvas);
  const dispose = (): void => {
    if (disposed) { return; } disposed = true; ++revision; clearTimeout(resizeTimer); forgetScroll(); resize.disconnect(); viewer.destroy();
    for (const font of fonts) { document.fonts.delete(font); }
  };
  const paint = (): Promise<void> => {
    clearTimeout(resizeTimer); resizeTimer = undefined;
    const current = ++revision;
    queue = queue.catch(() => undefined).then(async () => {
      if (disposed || current !== revision) { return; }
      const size = processor().getSlideDimensions();
      if (!(size.cx > 0 && size.cy > 0 && Number.isFinite(size.cx) && Number.isFinite(size.cy))) { throw new Error(t('Invalid slide dimensions.')); }
      // Allow for 16px padding on both sides and the one-pixel slide border.
      const availableWidth = (viewport.clientWidth || context.width()) - 34;
      const availableHeight = viewport.clientHeight > 0 ? viewport.clientHeight - 34 : Infinity;
      const width = Math.max(1, Math.min(availableWidth, availableHeight * size.cx / size.cy));
      canvas.style.width = `${width}px`; canvas.style.height = `${width * size.cy / size.cx}px`;
      await viewer.renderSlide(context.state.page - 1, canvas);
      if (disposed || current !== revision) { return; }
      const slide = processor().getCurrentSlide(context.state.page - 1);
      const xml = slide?.partUri ? await processor().processor.package.getPartByUri(slide.partUri)?.getDocumentContent() : undefined;
      if (disposed || current !== revision) { return; }
      text = xml ? Array.from(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagNameNS('*', 't')).map(node => node.textContent).join('\n') : '';
    });
    return queue;
  };
  const resize = new ResizeObserver(() => {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    if (disposed || width <= 0 || height <= 0 || width === observedWidth && height === observedHeight) { return; }
    observedWidth = width; observedHeight = height;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { void paint().catch(error => { if (!disposed) { context.error(error); } }); }, 150);
  });
  signal.addEventListener('abort', dispose, { once: true });
  try {
    // Use installed equivalents when a deck names the Windows Song typeface on macOS/Linux.
    const localSong = ['SimSun', 'Songti SC Regular', 'STSongti-SC-Regular', 'STSong',
      'NotoSerifCJKsc-Regular', 'SourceHanSerifSC-Regular'].map(family => `local("${family}")`).join(', ');
    const loaded = await Promise.all(['\u5b8b\u4f53', 'SimSun'].map(family =>
      new FontFace(family, `local("${family}"), ${localSong}`).load().catch(() => null)));
    signal.throwIfAborted(); fonts = loaded.filter((font): font is FontFace => font !== null);
    for (const font of fonts) { document.fonts.add(font); }
    await viewer.loadFile(bytes); signal.throwIfAborted();
    const count = viewer.getSlideCount(); if (!count) { throw new Error(t('No slides found.')); }
    context.state.page = Math.min(context.state.page, count); await paint(); signal.throwIfAborted();
    const tools = element('div'); tools.append(pager(context, count, () => { void paint().catch(context.error); }),
      button('copy', t('Copy slide text'), () => context.copy(text)));
    return { element: viewport, tools, activate: () => { forgetScroll = rememberScroll(viewport, context); resize.observe(viewport); }, dispose };
  } catch (error) { dispose(); throw error; }
};
export default render;
