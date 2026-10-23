import * as vscode from 'vscode';
import { parse, type ParseError } from 'jsonc-parser/lib/esm/main.js';

interface FileResource { path: string; kind: 'file' | 'directory' }
interface Icon { glyph?: string; font?: string; color?: string; size?: string; image?: string; mask?: boolean }
interface Font { id: string; src: string; format: string; weight: string; style: string }
interface Definition { iconPath?: string; fontCharacter?: string; fontColor?: string; fontSize?: string; fontId?: string }
interface ThemeFont { id: string; src: { path: string; format: string }[]; size?: string; weight?: string; style?: string }
interface Associations {
  file?: string; folder?: string; rootFolder?: string;
  fileNames?: Record<string, string>; fileExtensions?: Record<string, string>; folderNames?: Record<string, string>;
  rootFolderNames?: Record<string, string>; languageIds?: Record<string, string>;
}
interface Theme extends Associations {
  iconDefinitions: Record<string, Definition>; fonts?: ThemeFont[];
  light?: Associations; highContrast?: Associations; usesCurrentColor?: boolean; showLanguageModeIcons?: boolean;
}
interface LoadedTheme { document: Theme; root: vscode.Uri; directory: vscode.Uri; order: Map<string, number> }
interface Language { id: string; extensions?: string[]; filenames?: string[]; filenamePatterns?: string[]; icon?: { light: string; dark: string } }
const base64 = (data: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined => map && Object.hasOwn(map, key) ? map[key] : undefined;
const normalize = (path: string): string => path.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const size = (value: string | undefined): string | undefined => typeof value === 'string' && /^\d+(?:\.\d+)?(?:px|em|%)$/.test(value) ? value : undefined;
const color = (value: string | undefined): string | undefined => typeof value === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : undefined;

// Theme keys are case insensitive, just like the Explorer's generated CSS selectors.
function associations(value: Associations): Associations {
  const result = { ...value };
  for (const key of ['fileNames', 'fileExtensions', 'folderNames', 'rootFolderNames'] as const) {
    if (value[key]) result[key] = Object.fromEntries(Object.entries(value[key]!).map(([name, id]) => [name.toLowerCase(), id]));
  }
  if (value.languageIds) result.languageIds = { ...value.languageIds, ...(!value.languageIds.jsonc && value.languageIds.json ? { jsonc: value.languageIds.json } : {}) };
  return result;
}

// VS Code language associations use globs, not regular expressions. No file content is read to guess a language.
function matches(pattern: string, path: string): boolean {
  let expression = '', braces = 0;
  const input = pattern.toLowerCase();
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (character === '*') {
      if (input[i + 1] === '*') { i++; expression += input[i + 1] === '/' ? (i++, '(?:.*/)?') : '.*'; }
      else expression += '[^/]*';
    } else if (character === '?') expression += '[^/]';
    else if (character === '{') { braces++; expression += '(?:'; }
    else if (character === '}' && braces) { braces--; expression += ')'; }
    else if (character === ',' && braces) expression += '|';
    else if (character === '[') {
      const end = input.indexOf(']', i + 1);
      if (end > i + 1) { expression += input.slice(i, end + 1).replace(/^\[!/, '[^'); i = end; }
      else expression += '\\[';
    } else expression += character.replace(/[\\^$+?.()|{}\]]/g, '\\$&');
  }
  try { return new RegExp(`^${expression}$`).test(pattern.includes('/') ? path : path.split('/').at(-1)!); }
  catch { return false; }
}

/** Shares the installed Explorer icon theme between all project frames without copying the icon library. */
export class ProjectFileIcons implements vscode.Disposable {
  private generation = 0;
  private themeRevision = 0;
  private theme?: Promise<LoadedTheme | undefined>;
  private readonly assets = new Map<string, Promise<string | undefined>>();
  private readonly change = new vscode.EventEmitter<boolean>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly listeners: vscode.Disposable[];

  constructor() {
    let resetFonts = false;
    const invalidate = (reloadTheme = false): void => {
      this.generation++;
      if (reloadTheme) { resetFonts = true; this.themeRevision++; this.theme = undefined; this.assets.clear(); }
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (!this.disposed) this.change.fire(resetFonts); resetFonts = false; }, 100);
    };
    this.listeners = [
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('workbench.iconTheme')) invalidate(true);
        else if (event.affectsConfiguration('files.associations')) invalidate();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => invalidate()), vscode.extensions.onDidChange(() => invalidate(true)),
      vscode.workspace.onDidOpenTextDocument(() => invalidate()), vscode.workspace.onDidCloseTextDocument(() => invalidate()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => invalidate()),
    ];
  }

  dispose(): void {
    this.disposed = true; this.generation++; clearTimeout(this.timer);
    this.listeners.forEach(listener => listener.dispose()); this.change.dispose(); this.assets.clear(); this.theme = undefined;
  }

  bind(webview: vscode.Webview): { receive(message: unknown): boolean; dispose(): void } {
    let disposed = false, epoch = 0;
    const pending = new Set<string>(), sentFonts = new Set<string>();
    const changed = this.change.event(resetFonts => {
      if (resetFonts) sentFonts.clear();
      void webview.postMessage({ type: 'workflow-host', fileIconsChanged: { version: 1 } });
    });
    return {
      receive: (value: unknown): boolean => {
        const message = value as { type?: string; version?: number; requestId?: string; files?: FileResource[] } | undefined;
        if (!disposed && message?.type === 'workflow-frame-ready') { epoch++; pending.clear(); sentFonts.clear(); return true; }
        if (disposed || this.disposed || message?.type !== 'workflow-file-icons' || message.version !== 1
          || typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128
          || !Array.isArray(message.files) || message.files.length > 32
          || !message.files.every(file => file && typeof file.path === 'string' && file.path.length > 0 && file.path.length <= 4096
            && !/[\0\r\n]/.test(file.path) && (file.kind === 'file' || file.kind === 'directory'))) return false;
        const { requestId, files } = message;
        if (pending.has(requestId)) return true;
        pending.add(requestId);
        const generation = this.generation, themeRevision = this.themeRevision, currentEpoch = epoch;
        void (async () => {
          const theme = await (this.theme ??= this.loadTheme().catch(() => undefined));
          const icons = await Promise.all(files.map(async ({ path, kind }) => ({ path, kind, ...(theme ? await this.resolve(theme, { path, kind }, themeRevision) : {}) })));
          const fonts: Font[] = [];
          for (const id of new Set(icons.filter(icon => icon.glyph).map(icon => icon.font).filter((font): font is string => !!font))) {
            if (sentFonts.has(id) || !theme) continue;
            const index = Number(id.split('-').at(-1)), definition = theme.document.fonts?.[index];
            if (!definition) continue;
            for (const source of definition.src) {
              const format = source.format, mime = ({ woff2: 'font/woff2', woff: 'font/woff', truetype: 'font/ttf', opentype: 'font/otf' } as Record<string, string>)[format];
              if (!mime) continue;
              const src = await this.asset(theme.root, theme.directory, source.path, mime, 5 * 1024 * 1024);
              if (src) {
                fonts.push({ id, src, format, weight: /^(?:normal|bold|[1-9]00)$/.test(definition.weight ?? '') ? definition.weight! : 'normal', style: /^(?:normal|italic|oblique)$/.test(definition.style ?? '') ? definition.style! : 'normal' });
                break;
              }
            }
          }
          if (disposed || this.disposed || generation !== this.generation || currentEpoch !== epoch) return;
          const freshFonts = fonts.filter(font => !sentFonts.has(font.id));
          freshFonts.forEach(font => sentFonts.add(font.id));
          await webview.postMessage({ type: 'workflow-host', fileIcons: { version: 1, requestId, icons, fonts: freshFonts } });
        })().catch(() => {
          if (!disposed && !this.disposed && generation === this.generation && currentEpoch === epoch) void webview.postMessage({ type: 'workflow-host', fileIcons: { version: 1, requestId, icons: [], fonts: [] } });
        }).finally(() => { if (currentEpoch === epoch) pending.delete(requestId); });
        return true;
      },
      dispose: () => { disposed = true; changed.dispose(); pending.clear(); sentFonts.clear(); },
    };
  }

  private async loadTheme(): Promise<LoadedTheme | undefined> {
    const id = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme');
    if (!id) return;
    for (const extension of vscode.extensions.all) {
      const contribution = extension.packageJSON.contributes?.iconThemes?.find((theme: { id: string }) => theme.id === id);
      if (!contribution || typeof contribution.path !== 'string') continue;
      const uri = this.resource(extension.extensionUri, extension.extensionUri, contribution.path);
      if (!uri) return;
      const data = await vscode.workspace.fs.readFile(uri);
      if (data.byteLength > 5 * 1024 * 1024) return;
      const errors: ParseError[] = [], parsed = parse(new TextDecoder().decode(data), errors, { allowTrailingComma: true }) as Theme;
      if (errors.length || !parsed?.iconDefinitions) return;
      const document = { ...parsed, ...associations(parsed), light: parsed.light && associations(parsed.light), highContrast: parsed.highContrast && associations(parsed.highContrast) };
      const order = new Map<string, number>();
      for (const variant of [document, document.light, document.highContrast]) {
        if (!variant) continue;
        // The Explorer emits rules grouped by definition ID in this order, which also resolves specificity ties.
        for (const key of ['folder', 'folderExpanded', 'rootFolder', 'rootFolderExpanded', 'file', 'folderNames', 'folderNamesExpanded', 'rootFolderNames', 'rootFolderNamesExpanded', 'languageIds', 'fileExtensions', 'fileNames']) {
          const mapping = (variant as Record<string, unknown>)[key];
          for (const definition of typeof mapping === 'string' ? [mapping] : mapping && typeof mapping === 'object' ? Object.values(mapping) : []) {
            if (typeof definition === 'string' && !order.has(definition)) order.set(definition, order.size);
          }
        }
      }
      return { document, root: extension.extensionUri, directory: vscode.Uri.joinPath(uri, '..'), order };
    }
  }

  private language(path: string): { id: string; icon?: Language['icon']; root?: vscode.Uri } | undefined {
    const resource = vscode.Uri.file(path), normalized = normalize(resource.path), name = normalized.split('/').at(-1)!;
    const model = vscode.workspace.textDocuments.find(document => normalize(document.uri.path) === normalized && document.languageId !== 'plaintext');
    let configured: string | undefined, configuredLength = -1;
    for (const [pattern, id] of Object.entries(vscode.workspace.getConfiguration('files', resource).get<Record<string, string>>('associations') ?? {})) {
      if (typeof id === 'string' && pattern.length >= configuredLength && matches(pattern, normalized)) { configured = id; configuredLength = pattern.length; }
    }
    const fixed = model?.languageId ?? configured;
    let best: { id: string; icon?: Language['icon']; root?: vscode.Uri } | undefined, score = -1;
    for (const extension of vscode.extensions.all) {
      for (const language of (extension.packageJSON.contributes?.languages ?? []) as Language[]) {
        if (fixed) { if (language.id === fixed) return { ...language, root: extension.extensionUri }; continue; }
        const rank = language.filenames?.some(filename => filename.toLowerCase() === name) ? 100_000
          : Math.max(-1, ...(language.filenamePatterns ?? []).filter(pattern => matches(pattern, normalized)).map(pattern => 10_000 + pattern.length),
            ...(language.extensions ?? []).filter(ext => name.endsWith(ext.toLowerCase())).map(ext => ext.length));
        if (rank >= 0 && rank >= score) { score = rank; best = { ...language, root: extension.extensionUri }; }
      }
    }
    return fixed ? { id: fixed } : best;
  }

  private async resolve(theme: LoadedTheme, file: FileResource, themeRevision: number): Promise<Icon> {
    const path = normalize(vscode.Uri.file(file.path).path), segments = path.split('/'), name = segments.at(-1)!, parent = segments.at(-2);
    const { document, order } = theme, kind = vscode.window.activeColorTheme.kind;
    const variant = kind === vscode.ColorThemeKind.Light ? document.light
      : kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight ? document.highContrast : undefined;
    const language = file.kind === 'file' ? this.language(file.path) : undefined;
    const rootFolder = file.kind === 'directory' && vscode.workspace.workspaceFolders?.some(folder => normalize(folder.uri.path) === path);
    const candidates = new Map<string, number>();
    const add = (id: string | undefined, score: number): void => { if (id && own(document.iconDefinitions, id)) candidates.set(id, Math.max(score, candidates.get(id) ?? 0)); };
    for (const [associations, extra] of [[document, 0], [variant, 1]] as const) {
      if (!associations) continue;
      if (file.kind === 'directory') {
        add(rootFolder ? associations.rootFolder || associations.folder : associations.folder, 2 + extra);
        const names = rootFolder ? associations.rootFolderNames : associations.folderNames;
        add(own(names, name), 3 + extra);
        if (!rootFolder && parent) add(own(names, `${parent}/${name}`), 4 + extra);
      } else {
        add(associations.file, 2 + extra); add(language && own(associations.languageIds, language.id), 3 + extra);
        const dots = name.length <= 255 ? name.split('.') : [name];
        for (let i = 1; i < dots.length; i++) {
          const extension = dots.slice(i).join('.'), score = dots.length - i + 3 + extra;
          add(own(associations.fileExtensions, extension), score);
          if (parent) add(own(associations.fileExtensions, `${parent}/${extension}`), score + 1);
        }
        add(own(associations.fileNames, name), dots.length + 4 + extra);
        if (parent) add(own(associations.fileNames, `${parent}/${name}`), dots.length + 5 + extra);
      }
    }
    const result: Icon = {};
    const defaultFont = document.fonts?.[0];
    const setFont = (definition: Definition): void => {
      const index = document.fonts?.findIndex(font => font.id === (definition.fontId ?? defaultFont?.id)) ?? -1;
      if (index >= 0) { result.font = `sh-file-icon-${themeRevision}-${index}`; result.size = size(definition.fontSize) ?? size(document.fonts![index].size) ?? size(defaultFont?.size) ?? '150%'; }
    };
    setFont({});
    const covered = own(document.languageIds, language?.id ?? '') || own(variant?.languageIds, language?.id ?? '');
    if (language?.icon && language.root && !covered && document.showLanguageModeIcons !== false && (document.showLanguageModeIcons || document.fileExtensions || document.fileNames || document.languageIds)) {
      const image = await this.image(language.root, language.root, kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? language.icon.light : language.icon.dark);
      if (image) result.image = image;
    }
    for (const [id] of [...candidates].sort(([a, scoreA], [b, scoreB]) => scoreA - scoreB || (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
      const definition = document.iconDefinitions[id];
      if (definition.iconPath) {
        const image = await this.image(theme.root, theme.directory, definition.iconPath);
        if (image) { result.image = image; result.mask = document.usesCurrentColor === true; delete result.glyph; }
      } else if (definition.fontCharacter || definition.fontColor) {
        if (definition.fontCharacter) {
          result.glyph = definition.fontCharacter.replace(/\\([\da-f]{1,6})\s?/gi, (_, hex: string) => {
            const code = Number.parseInt(hex, 16); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
          });
          setFont(definition); delete result.image; delete result.mask;
        }
        if (color(definition.fontColor)) result.color = color(definition.fontColor);
        if (size(definition.fontSize)) result.size = size(definition.fontSize);
      }
    }
    return result;
  }

  private image(root: vscode.Uri, directory: vscode.Uri, path: string): Promise<string | undefined> {
    const extension = path.split('.').at(-1)?.toLowerCase(), mime = ({ svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[extension ?? ''];
    return mime ? this.asset(root, directory, path, mime, 1024 * 1024) : Promise.resolve(undefined);
  }

  private resource(root: vscode.Uri, directory: vscode.Uri, path: string): vscode.Uri | undefined {
    if (typeof path !== 'string' || /^[a-z][\w+.-]*:|^[\\/]/i.test(path) || /[\0\r\n?#]/.test(path)) return;
    const uri = vscode.Uri.joinPath(directory, path);
    if (uri.scheme === root.scheme && uri.authority === root.authority && uri.path.startsWith(`${root.path.replace(/\/$/, '')}/`)) return uri;
  }

  private asset(root: vscode.Uri, directory: vscode.Uri, path: string, mime: string, limit: number): Promise<string | undefined> {
    const uri = this.resource(root, directory, path);
    if (!uri) return Promise.resolve(undefined);
    const key = uri.toString();
    let pending = this.assets.get(key);
    if (!pending) {
      pending = Promise.resolve(vscode.workspace.fs.readFile(uri)).then(data => data.byteLength <= limit ? `data:${mime};base64,${base64(data)}` : undefined, () => undefined);
      this.assets.set(key, pending);
    }
    return pending;
  }
}
