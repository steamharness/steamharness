import * as XLSX from 'xlsx';

export interface PreviewSheet {
  name: string;
  rows: number;
  cols: number;
  cells: Record<string, string>;
  widths: number[];
  merges: XLSX.Range[];
}

export function parseSpreadsheet(bytes: Uint8Array): PreviewSheet[] {
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true, cellStyles: true });
  return workbook.SheetNames.flatMap((name, index) => {
    if (workbook.Workbook?.Sheets?.[index]?.Hidden) { return []; }
    const source = workbook.Sheets[name], range = XLSX.utils.decode_range(source['!ref'] ?? 'A1');
    const entries = Object.entries(source).filter(([key]) => !key.startsWith('!')) as [string, XLSX.CellObject][];
    const merges = source['!merges'] ?? [];
    let rows = range.e.r + 1, cols = range.e.c + 1, mergedCells = 0;
    for (const [key] of entries) { const cell = XLSX.utils.decode_cell(key); rows = Math.max(rows, cell.r + 1); cols = Math.max(cols, cell.c + 1); }
    for (const merge of merges) {
      if (merge.s.r < 0 || merge.s.c < 0 || merge.e.r < merge.s.r || merge.e.c < merge.s.c) { throw new Error('SPREADSHEET_RANGE_LIMIT'); }
      rows = Math.max(rows, merge.e.r + 1); cols = Math.max(cols, merge.e.c + 1);
      mergedCells += (merge.e.r - merge.s.r + 1) * (merge.e.c - merge.s.c + 1);
    }
    if (rows > 20_000 || cols > 200 || entries.length > 200_000 || mergedCells > 200_000) { throw new Error('SPREADSHEET_RANGE_LIMIT'); }
    const cells: Record<string, string> = {};
    for (const [key, cell] of entries) { cells[key] = cell.f && cell.v === undefined ? `=${cell.f}` : XLSX.utils.format_cell(cell); }
    rows = Math.max(rows, 30); cols = Math.max(cols, 10);
    const widths = Array.from({ length: cols }, (_, col) => Math.min(800, Math.max(40, source['!cols']?.[col]?.wpx ?? (source['!cols']?.[col]?.wch ?? 13) * 7 + 5)));
    return [{ name, rows, cols, cells, widths, merges }];
  });
}
