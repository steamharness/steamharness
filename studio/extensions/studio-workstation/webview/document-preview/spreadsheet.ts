import { t } from '../localization';
import { element, previewWorker, type PreviewRenderer } from './view';
import type { PreviewSheet } from './spreadsheet-model';

function columnName(column: number): string {
  let result = ''; for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) { result = String.fromCharCode(65 + (value - 1) % 26) + result; } return result;
}

async function readSheets(bytes: Uint8Array, signal: AbortSignal): Promise<PreviewSheet[]> {
  const resource = await previewWorker('./spreadsheet-worker.js', signal), worker = resource.worker;
  try {
    return await new Promise((resolve, reject) => {
      const abort = (): void => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      worker.onmessage = event => {
        signal.removeEventListener('abort', abort);
        if (event.data.error) { reject(new Error(event.data.error === 'SPREADSHEET_RANGE_LIMIT'
          ? t('Workbook exceeds the preview limit (20,000 rows, 200 columns, 200,000 cells).') : event.data.error)); }
        else { resolve(event.data.sheets); }
      };
      worker.onerror = event => { signal.removeEventListener('abort', abort); reject(new Error(event.message)); };
      const data = bytes.slice(); worker.postMessage(data, [data.buffer]);
    });
  } finally { resource.dispose(); }
}

const render: PreviewRenderer = async (bytes, context, signal) => {
  const sheets = await readSheets(bytes, signal); signal.throwIfAborted();
  if (!sheets.length) { throw new Error(t('No visible worksheets.')); }
  const root = element('div', 'spreadsheet'), viewport = element('div', 'sheet-scroll'), tabs = element('div', 'sheet-tabs');
  tabs.setAttribute('role', 'tablist'); tabs.ariaLabel = t('Worksheets'); root.append(viewport, tabs);
  let current = sheets.find(sheet => sheet.name === context.state.sheet) ?? sheets[0], from = -1, body: HTMLTableSectionElement;
  let frame = 0;
  const draw = (): void => {
    const start = Math.max(0, Math.floor(viewport.scrollTop / 28) - 20), end = Math.min(current.rows, start + Math.max(100, Math.ceil(viewport.clientHeight / 28) + 40));
    if (start === from) { return; } from = start;
    const fragment = document.createDocumentFragment();
    const spacer = (height: number): void => {
      if (!height) { return; } const row = element('tr'), cell = element('td'); cell.colSpan = current.cols + 1;
      cell.style.cssText = `height:${height}px;padding:0;border:0`; row.append(cell); fragment.append(row);
    };
    spacer(start * 28);
    const merges = current.merges.filter(merge => merge.e.r >= start && merge.s.r < end);
    const mergedCells = new Map<number, PreviewSheet['merges'][number]>();
    for (const merge of merges) {
      for (let row = Math.max(start, merge.s.r); row < Math.min(end, merge.e.r + 1); row++) {
        for (let column = merge.s.c; column <= merge.e.c; column++) { mergedCells.set(row * current.cols + column, merge); }
      }
    }
    for (let r = start; r < end; r++) {
      const row = element('tr'); row.style.height = '28px'; row.append(element('th', '', String(r + 1)));
      for (let c = 0; c < current.cols; c++) {
        const merge = mergedCells.get(r * current.cols + c);
        if (merge && (c !== merge.s.c || r !== Math.max(start, merge.s.r))) { continue; }
        const address = `${columnName(merge?.s.c ?? c)}${(merge?.s.r ?? r) + 1}`;
        const cell = element('td', '', current.cells[address] ?? ''); cell.title = cell.textContent ?? ''; cell.tabIndex = 0; cell.dataset.cell = address;
        if (merge) { cell.rowSpan = Math.min(end - 1, merge.e.r) - r + 1; cell.colSpan = merge.e.c - merge.s.c + 1; }
        row.append(cell);
      }
      fragment.append(row);
    }
    spacer((current.rows - end) * 28); body.replaceChildren(fragment);
  };
  const select = (sheet: PreviewSheet, reset: boolean): void => {
    current = sheet; from = -1; context.state.sheet = current.name;
    if (reset) { context.state.top = context.state.left = 0; } context.save();
    const table = element('table', 'sheet-grid'); table.ariaLabel = current.name;
    const cols = element('colgroup'), index = element('col'); index.style.width = '48px'; cols.append(index);
    for (const width of current.widths) { const col = element('col'); col.style.width = `${width}px`; cols.append(col); }
    table.style.width = `${48 + current.widths.reduce((sum, width) => sum + width, 0)}px`;
    const header = element('thead'), labels = element('tr'); labels.append(element('th'));
    for (let column = 0; column < current.cols; column++) { labels.append(element('th', '', columnName(column))); } header.append(labels);
    body = element('tbody'); table.append(cols, header, body); viewport.replaceChildren(table);
    for (const tab of Array.from(tabs.children)) { tab.setAttribute('aria-selected', String(tab.textContent === current.name)); }
    // Render around the restored position before assigning scrollTop to the new table.
    const top = context.state.top; viewport.scrollTop = top; draw(); viewport.scrollTop = top; viewport.scrollLeft = context.state.left;
  };
  for (const sheet of sheets) { const tab = element('button', '', sheet.name); tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.addEventListener('click', () => select(sheet, true)); tabs.append(tab); }
  const scroll = (): void => {
    context.state.top = viewport.scrollTop; context.state.left = viewport.scrollLeft; context.save();
    cancelAnimationFrame(frame); frame = requestAnimationFrame(draw);
  };
  viewport.addEventListener('scroll', scroll);
  const resize = new ResizeObserver(() => { from = -1; cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); });
  return { element: root, activate: () => { select(current, false); resize.observe(viewport); },
    dispose: () => { viewport.removeEventListener('scroll', scroll); resize.disconnect(); cancelAnimationFrame(frame); } };
};
export default render;
