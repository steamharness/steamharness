import { t } from '../localization';

type Message = Record<string, any>;
const maxBytes = 50 * 1024 * 1024;

export class ClipboardImages {
  private native = false;
  private pending?: { id: string; resolve(files: File[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  constructor(private readonly send: (message: Message) => void) {}
  enable(version: unknown): void { this.native = version === 1; }

  async read(): Promise<File[]> {
    if (!this.native) {
      if (!navigator.clipboard?.read) { throw new Error(t('Clipboard image reading is unavailable in this browser.')); }
      let items: ClipboardItems;
      try { items = await navigator.clipboard.read(); }
      catch { throw new Error(t('Could not read clipboard images. Allow clipboard access and try again.')); }
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find(type => type === 'image/png') ?? item.types.find(type => type.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        if (blob.size > maxBytes) { throw new Error(t('Attachment exceeds 50 MiB.')); }
        const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1].replace(/[^a-z0-9]/gi, '') || 'png';
        files.push(new File([blob], `clipboard-${files.length + 1}.${extension}`, { type }));
      }
      if (!files.length) { throw new Error(t('No image found in the clipboard.')); }
      return files;
    }
    if (this.pending) { throw new Error(t('Clipboard image reading is already in progress.')); }
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = undefined; reject(new Error(t('Clipboard image reading timed out.'))); }, 10_000);
      this.pending = { id, resolve, reject, timer };
      try { this.send({ type: 'workflow-edit', version: 1, command: 'paste', clipboardImageRequestId: id }); }
      catch (error) { clearTimeout(timer); this.pending = undefined; reject(error); }
    });
  }

  receive(reply: Message | undefined): void {
    if (reply?.version !== 1 || !this.pending || reply.requestId !== this.pending.id) return;
    const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
    if (!ArrayBuffer.isView(reply.image) || !reply.image.byteLength) { pending.reject(new Error(t('No image found in the clipboard.'))); return; }
    if (reply.image.byteLength > maxBytes) { pending.reject(new Error(t('Attachment exceeds 50 MiB.'))); return; }
    const image = new Uint8Array(reply.image.buffer, reply.image.byteOffset, reply.image.byteLength);
    pending.resolve([new File([new Uint8Array(image)], 'clipboard.png', { type: 'image/png' })]);
  }

  receivePaste(clipboard: Message | undefined): boolean {
    if (!this.pending || !clipboard) return false;
    this.receive({ version: 1, requestId: this.pending.id, image: clipboard.image });
    return true;
  }

  dispose(): void {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error(t('Connection changed.'))); this.pending = undefined; }
  }
}
