import { capturePickedDirectory, capturePickedFiles, type FileImport, type PickedDirectory } from './conversation-drop';

export async function chooseConversationFiles(kind: 'files' | 'folders'): Promise<FileImport | undefined> {
  const directoryPicker = (window as unknown as { showDirectoryPicker?: (options: { mode: 'read' }) => Promise<PickedDirectory> }).showDirectoryPicker;
  if (kind === 'folders' && directoryPicker) {
    try { return capturePickedDirectory(await directoryPicker.call(window, { mode: 'read' })); }
    catch (error) {
      if ((error as Error).name === 'AbortError') return;
      if (!['SecurityError', 'NotAllowedError', 'NotSupportedError'].includes((error as Error).name)) throw error;
    }
  }
  return new Promise((resolve, reject) => {
    const picker = document.createElement('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true;
    if (kind === 'folders') picker.webkitdirectory = true;
    const finish = (selection?: FileImport) => { picker.remove(); resolve(selection); };
    picker.addEventListener('change', () => {
      const files = Array.from(picker.files ?? []);
      finish(files.length ? capturePickedFiles(files, kind === 'folders') : undefined);
    }, { once: true });
    picker.addEventListener('cancel', () => finish(), { once: true });
    document.body.append(picker);
    try { picker.click(); } catch (error) { picker.remove(); reject(error); }
  });
}
