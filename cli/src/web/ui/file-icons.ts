interface Resource { path: string; kind: 'file' | 'directory' }
interface Icon extends Resource { glyph?: string; font?: string; color?: string; size?: string; image?: string; mask?: boolean }
interface Font { id: string; src: string; format: string; weight: string; style: string }
const key = (resource: Resource): string => JSON.stringify([resource.kind, resource.path]);
const fontId = (value: unknown): value is string => typeof value === 'string' && /^sh-file-icon-\d+-\d+$/.test(value);
const imageData = (value: unknown): value is string => typeof value === 'string' && /^data:image\/(?:svg\+xml|png|jpeg|gif|webp);base64,[\w+/=]+$/.test(value);

/** Resolves all conversation card icons through Studio's active Explorer theme. */
export class FileIcons {
  private enabled = false;
  private disposed = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly targets = new Map<HTMLElement, Resource>();
  private readonly cache = new Map<string, Icon>();
  private readonly displayed = new Map<string, Icon>();
  private readonly requested = new Set<string>();
  private readonly pending = new Map<string, { generation: number; resources: Resource[] }>();
  private readonly fonts = new Set<string>();
  private readonly styles: HTMLStyleElement[] = [];

  constructor(private readonly post: (message: Record<string, unknown>) => void) {}

  bind(element: HTMLElement, path: string, kind: Resource['kind'] = 'file'): void {
    element.classList.add('file-theme-icon'); element.setAttribute('aria-hidden', 'true');
    const resource = { path, kind };
    this.targets.set(element, resource);
    this.render(element, this.cache.get(key(resource)) ?? this.displayed.get(key(resource)) ?? resource);
    this.schedule();
  }

  receive(message: Record<string, any>): boolean {
    if (this.disposed) return false;
    if (message.type === 'file-icons-changed') {
      this.enabled = message.enabled === true; this.generation++;
      this.cache.clear(); this.pending.clear(); this.requested.clear();
      this.schedule(); return true;
    }
    if (message.type !== 'file-icons') return false;
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.generation !== this.generation) return true;
    this.pending.delete(message.requestId);
    for (const font of (Array.isArray(message.fonts) ? message.fonts : []) as Font[]) this.registerFont(font);
    const icons = new Map<string, Icon>();
    for (const icon of Array.isArray(message.icons) ? message.icons : []) {
      if (icon && typeof icon.path === 'string' && (icon.kind === 'file' || icon.kind === 'directory')) icons.set(key(icon), icon);
    }
    for (const resource of pending.resources) {
      const id = key(resource); this.requested.delete(id);
      const icon = icons.get(id) ?? resource;
      this.cache.set(id, icon); this.displayed.set(id, icon);
    }
    for (const [element, resource] of this.targets) {
      if (!element.isConnected) this.targets.delete(element);
      else if (this.cache.has(key(resource))) this.render(element, this.cache.get(key(resource))!);
    }
    return true;
  }

  dispose(): void {
    this.disposed = true; clearTimeout(this.timer); this.timer = undefined;
    this.targets.clear(); this.cache.clear(); this.displayed.clear(); this.pending.clear(); this.requested.clear();
    this.styles.forEach(style => style.remove()); this.styles.length = 0; this.fonts.clear();
  }

  private schedule(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const resources = new Map<string, Resource>();
      for (const [element, resource] of this.targets) {
        if (!element.isConnected) { this.targets.delete(element); continue; }
        const id = key(resource);
        if (this.enabled && !this.cache.has(id) && !this.requested.has(id)) resources.set(id, resource);
        else if (!this.enabled) this.render(element, resource);
      }
      const entries = [...resources.values()];
      for (let offset = 0; offset < entries.length; offset += 32) {
        const files = entries.slice(offset, offset + 32), requestId = crypto.randomUUID();
        files.forEach(file => this.requested.add(key(file)));
        this.pending.set(requestId, { generation: this.generation, resources: files });
        this.post({ type: 'file-icons', requestId, files });
      }
    }, 16);
  }

  private registerFont(font: Font): void {
    if (!font || !fontId(font.id) || this.fonts.has(font.id) || typeof font.src !== 'string'
      || !/^data:font\/(?:woff2?|ttf|otf);base64,[\w+/=]+$/.test(font.src)
      || !['woff2', 'woff', 'truetype', 'opentype'].includes(font.format)
      || !/^(?:normal|bold|[1-9]00)$/.test(font.weight) || !/^(?:normal|italic|oblique)$/.test(font.style)) return;
    const style = document.createElement('style');
    style.textContent = `@font-face{font-family:"${font.id}";src:url("${font.src}") format("${font.format}");font-weight:${font.weight};font-style:${font.style};font-display:block}`;
    document.head.append(style); this.styles.push(style); this.fonts.add(font.id);
  }

  private render(element: HTMLElement, icon: Icon): void {
    element.replaceChildren(); element.removeAttribute('style');
    if (typeof icon.color === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(icon.color)) element.style.color = icon.color;
    if (imageData(icon.image)) {
      if (icon.mask) {
        const mask = document.createElement('span'); mask.className = 'file-theme-mask';
        mask.style.maskImage = `url("${icon.image}")`; mask.style.webkitMaskImage = `url("${icon.image}")`; element.append(mask);
      } else {
        const image = document.createElement('img'); image.src = icon.image; image.alt = ''; element.append(image);
      }
    } else if (typeof icon.glyph === 'string' && icon.glyph.length <= 16 && fontId(icon.font) && this.fonts.has(icon.font)) {
      element.textContent = icon.glyph; element.style.fontFamily = `"${icon.font}"`;
      if (typeof icon.size === 'string' && /^\d+(?:\.\d+)?(?:px|em|%)$/.test(icon.size)) element.style.fontSize = icon.size;
    } else {
      const symbol = document.createElement('span'); symbol.className = `codicon codicon-${icon.kind === 'directory' ? 'folder' : 'file'}`; element.append(symbol);
    }
  }
}
