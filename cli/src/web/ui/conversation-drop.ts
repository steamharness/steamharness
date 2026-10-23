export interface DroppedEntry { name: string; kind: 'file' | 'directory'; data?: string }
interface Entry {
  name: string; isDirectory: boolean;
  file(success: (file: File) => void, error: (error: DOMException) => void): void;
  createReader(): { readEntries(success: (entries: Entry[]) => void, error: (error: DOMException) => void): void };
}

const formats = ['files', 'codefiles', 'resourceurls', 'codeeditors', 'text/uri-list'];
export function isFileDrop(transfer: DataTransfer): boolean { return Array.from(transfer.types).some(type => formats.includes(type.toLowerCase())); }

/** Capture protected drag data synchronously, before awaiting directory reads. */
export function captureFileDrop(transfer: DataTransfer): { paths: string[]; files?: File[]; directories?: boolean; read(): Promise<DroppedEntry[]> } {
  const paths: string[] = [];
  const add = (value: unknown) => { if (typeof value === 'string' && /^(?:file:|\/|[a-z]:[\\/]|\\\\)/i.test(value)) paths.push(value); };
  for (const format of ['CodeFiles', 'ResourceURLs', 'CodeEditors']) {
    try {
      const actual = Array.from(transfer.types).find(type => type.toLowerCase() === format.toLowerCase()) ?? format;
      const entries = JSON.parse(transfer.getData(actual));
      if (Array.isArray(entries)) for (const entry of entries) {
        if (typeof entry === 'string') add(entry);
        else if (entry?.resource?.scheme === 'file' && typeof entry.resource.path === 'string') {
          const uri = new URL('file:///'); uri.hostname = entry.resource.authority ?? ''; uri.pathname = entry.resource.path; add(uri.href);
        } else add(entry?.resource?.external ?? entry?.resource);
      }
    } catch { /* Other applications use different transfer formats. */ }
  }
  for (const line of transfer.getData('text/uri-list').split(/\r?\n/)) if (!line.startsWith('#') && line.startsWith('file:')) add(line);
  const files = Array.from(transfer.files);
  for (const file of files) add((file as File & { path?: string }).path);
  const entries = Array.from(transfer.items ?? []).filter(item => item.kind === 'file').map(item => item.webkitGetAsEntry?.() as Entry | null);
  return { paths: [...new Set(paths)], files, directories: entries.some(entry => entry?.isDirectory), read: async () => {
    const output: DroppedEntry[] = [];
    let bytes = 0;
    const append = (entry: DroppedEntry) => { output.push(entry); if (output.length > 1000) throw new Error('A drop can contain up to 1,000 files and folders.'); };
    const read = async (file: File, name: string) => {
      bytes += file.size;
      if (bytes > 50 * 1024 * 1024) throw new Error('Dropped files exceed 50 MiB.');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',', 2)[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
      });
      append({ name, kind: 'file', data });
    };
    const walk = async (entry: Entry, name: string): Promise<void> => {
      if (!entry.isDirectory) { await read(await new Promise<File>((resolve, reject) => entry.file(resolve, reject)), name); return; }
      append({ name, kind: 'directory' });
      const reader = entry.createReader();
      while (true) {
        const children = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!children.length) break;
        for (const child of children) await walk(child, `${name}/${child.name}`);
      }
    };
    if (entries.some(Boolean)) {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (entry) await walk(entry, entry.name);
        else if (files[index]) await read(files[index], files[index].name);
      }
    } else for (const file of files) await read(file, file.name);
    return output;
  } };
}
