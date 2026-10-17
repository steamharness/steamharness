import { parseSpreadsheet } from './spreadsheet-model';
const scope = self as unknown as { onmessage: (event: MessageEvent<Uint8Array>) => void; postMessage(message: unknown): void };
scope.onmessage = event => {
  try { scope.postMessage({ sheets: parseSpreadsheet(event.data) }); }
  catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
