import { t } from './localization';
import * as vscode from 'vscode';
import { IMPORTED_PROJECTS_KEY, projectId, readImportedProjects, readRecentProjects, readRelatedProjects, rememberImportedProjects,
  projectTypeIcons, type ImportedProject, type RelatedProject, type ProjectType } from './projects';
import type { ProjectIcons } from './project-icons';
import type { Project } from './workflow-types';
import type { RelatedProjectBinding } from './workflow-cli-types';
import type { DownloadedServerProject } from './steamharness-server-projects';

interface RelatedProjectItem extends RelatedProject {
  ownerUri: string;
  imported?: ImportedProject;
  projectType?: ProjectType;
  avatarUrl?: string;
}

export async function readProjectManifest(uri: vscode.Uri): Promise<unknown> {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(uri, 'package.json'));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readImportedProject(uri: vscode.Uri): Promise<ImportedProject | undefined> {
  try {
    const pkg = await readProjectManifest(uri) as { id?: unknown; name?: unknown; version?: unknown; steamHarness?: { projectInfo?: { localizedNames?: unknown } } } | null;
    const id = projectId(pkg?.id);
    if (id) {
      const names = pkg?.steamHarness?.projectInfo?.localizedNames;
      const language = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
      const localized = names && typeof names === 'object' && !Array.isArray(names)
        ? Object.entries(names).find(([locale]) => locale.trim().toLowerCase() === language)?.[1] : undefined;
      const name = typeof localized === 'string' && localized.trim() ? localized.trim()
        : typeof pkg?.name === 'string' && pkg.name.trim() ? pkg.name : uri.path.split('/').at(-1) || id;
      return { id, uri: uri.toString(), name, version: typeof pkg?.version === 'string' ? pkg.version : undefined };
    }
  } catch { /* An imported project can have moved or become unavailable. */ }
  return undefined;
}

export async function resolveImportedRelatedProject(context: Pick<vscode.ExtensionContext, 'globalState'>, relation: RelatedProject, ownerUri?: string): Promise<ImportedProject | undefined> {
  const registry = readImportedProjects(context.globalState.get(IMPORTED_PROJECTS_KEY));
  const candidates = registry.filter(project => project.id === relation.projectId);
  const downloadRootUri = registry.find(project => project.uri === ownerUri)?.downloadRootUri;
  const known = downloadRootUri ? candidates.filter(project => project.downloadRootUri === downloadRootUri)
    : [...candidates.filter(project => !project.downloadRootUri), ...candidates.filter(project => project.downloadRootUri)];
  for (const project of known) {
    const imported = await readImportedProject(vscode.Uri.parse(project.uri));
    if (imported?.id === relation.projectId && (!downloadRootUri || imported.version === project.version)) { return imported; }
  }
  // Locally cloned project groups keep every project as a sibling folder and
  // the user often opens just one of them. That project never passes through
  // the import flow, so the registry knows nothing about its neighbours and
  // the runtime would report the relation as unavailable. A sibling whose UUID
  // matches is the same project the relation names; use it without requiring a
  // manual import. Downloaded groups keep the version pin above and never take
  // this path.
  if (!downloadRootUri) { return findSiblingRelatedProject(ownerUri, relation.projectId); }
  return undefined;
}

async function findSiblingRelatedProject(ownerUri: string | undefined, projectId: string): Promise<ImportedProject | undefined> {
  if (!ownerUri) { return undefined; }
  const owner = vscode.Uri.parse(ownerUri);
  if (owner.scheme !== 'file') { return undefined; }
  let entries: [string, vscode.FileType][];
  try { entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(owner, '..')); } catch { return undefined; }
  const matches: ImportedProject[] = [];
  for (const [name, type] of entries.slice(0, 256)) {
    if (type !== vscode.FileType.Directory || name.startsWith('.')) { continue; }
    const project = await readImportedProject(vscode.Uri.joinPath(vscode.Uri.joinPath(owner, '..'), name));
    if (project?.id === projectId) { matches.push(project); }
  }
  // Two copies of the same UUID next to the owner are ambiguous; an explicit
  // import is then the only way to say which one the relation should use.
  return matches.length === 1 ? matches[0] : undefined;
}

export class RelatedProjectsView implements vscode.TreeDataProvider<RelatedProjectItem>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  private readonly bindingsChange = new vscode.EventEmitter<void>();
  readonly onDidChangeBindings = this.bindingsChange.event;
  private readonly view: vscode.TreeView<RelatedProjectItem>;
  private readonly ready: Promise<void>;
  private projects: Project[] = [];
  private selected?: Project;
  private items: RelatedProjectItem[] = [];
  private pendingSave = Promise.resolve();
  private loading = Promise.resolve();
  private reloading = false;
  private reloadRequested = false;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private displayedUri?: string;
  private published = '';
  private generation = 0;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel,
    discover: (root: vscode.Uri) => Promise<vscode.Uri[]>, private readonly icons?: ProjectIcons) {
    this.view = vscode.window.createTreeView('studio.relatedProjects', { treeDataProvider: this });
    this.view.title = t("Related Projects");
    context.subscriptions.push(this, this.view,
      vscode.commands.registerCommand('studio.openRelatedProject', (item?: RelatedProjectItem) => this.open(item)),
      vscode.commands.registerCommand('studio.refreshRelatedProjects', () => this.reload()),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) { this.scheduleReload(); } }),
    );
    this.ready = this.migrate(discover).catch(error => output.appendLine(`Related projects: ${String(error)}`));
    if (icons) { context.subscriptions.push(icons.onDidChange(() => this.scheduleReload())); }
  }

  update(projects: Project[], preferred?: Project): Promise<void> {
    const available = projects.filter(project => !project.assistant);
    const selected = available.find(project => project.uri === preferred?.uri) ?? available[0];
    const changed = available.length !== this.projects.length || available.some((project, index) => project !== this.projects[index]);
    this.projects = available;
    if (!changed && selected === this.selected) { return this.loading; }
    this.selected = selected;
    return this.reload();
  }

  private remember(imported: ImportedProject[]): Promise<void> {
    this.pendingSave = this.pendingSave.catch(() => undefined).then(async () => {
      const previous = readImportedProjects(this.context.globalState.get(IMPORTED_PROJECTS_KEY));
      const next = rememberImportedProjects(previous, imported);
      if (JSON.stringify(previous) !== JSON.stringify(next) || this.context.globalState.get(IMPORTED_PROJECTS_KEY) === undefined) {
        await this.context.globalState.update(IMPORTED_PROJECTS_KEY, next);
      }
    });
    return this.pendingSave;
  }

  async rememberProjectGroup(projects: DownloadedServerProject[], replacedRoot?: string): Promise<void> {
    await this.ready;
    const root = projects.find(project => project.role === 'root');
    if (!root) { throw new Error(t('The server returned an invalid response.')); }
    const downloadRootUri = vscode.Uri.file(root.directory).toString();
    this.pendingSave = this.pendingSave.catch(() => undefined).then(async () => {
      const previous = readImportedProjects(this.context.globalState.get(IMPORTED_PROJECTS_KEY));
      const incoming = projects.map(project => ({
        id: project.id, name: project.name, version: project.version, uri: vscode.Uri.file(project.directory).toString(), downloadRootUri,
      }));
      const uris = new Set(incoming.map(project => project.uri));
      try {
        await this.context.globalState.update(IMPORTED_PROJECTS_KEY, rememberImportedProjects(
          previous.filter(project => !replacedRoot || project.downloadRootUri !== replacedRoot), incoming));
      } catch (error) {
        const current = readImportedProjects(this.context.globalState.get(IMPORTED_PROJECTS_KEY));
        await this.context.globalState.update(IMPORTED_PROJECTS_KEY, rememberImportedProjects(
          current.filter(project => !uris.has(project.uri) && project.downloadRootUri !== downloadRootUri),
          previous.filter(project => uris.has(project.uri) || project.downloadRootUri === downloadRootUri)));
        throw error;
      }
    });
    await this.pendingSave;
    await this.reload();
  }

  private async migrate(discover: (root: vscode.Uri) => Promise<vscode.Uri[]>): Promise<void> {
    if (Array.isArray(this.context.globalState.get(IMPORTED_PROJECTS_KEY))) { return; }
    const folders = readRecentProjects(this.context.globalState.get('studio.recentProjects')).filter(project => project.kind === 'folder');
    const candidates = (await Promise.all(folders.map(project => discover(vscode.Uri.parse(project.uri))))).flat();
    const imported = await Promise.all([...new Map(candidates.map(uri => [uri.toString(), uri])).values()].map(readImportedProject));
    await this.remember(imported.filter((project): project is ImportedProject => !!project));
  }

  async bindings(project: Project): Promise<RelatedProjectBinding[]> {
    if (project.assistant || this.disposed) { return []; }
    await this.ready;
    await this.pendingSave;
    const relations = readRelatedProjects(await readProjectManifest(vscode.Uri.parse(project.uri)));
    const bindings = await Promise.all(relations.map(async relation => {
      const imported = await resolveImportedRelatedProject(this.context, relation, project.uri);
      return imported ? { alias: relation.alias, projectDir: vscode.Uri.parse(imported.uri).fsPath } : undefined;
    }));
    return bindings.filter((binding): binding is RelatedProjectBinding => !!binding);
  }

  async resourceProjects(): Promise<string[]> {
    await this.ready; await this.loading; await this.pendingSave;
    const imported = await Promise.all(readImportedProjects(this.context.globalState.get(IMPORTED_PROJECTS_KEY)).map(async project => {
      const current = await readImportedProject(vscode.Uri.parse(project.uri));
      return current?.id === project.id && vscode.Uri.parse(current.uri).scheme === 'file' ? vscode.Uri.parse(current.uri).fsPath : undefined;
    }));
    return [...new Set(imported.filter((directory): directory is string => !!directory))].slice(0, 100);
  }

  private reload(): Promise<void> {
    clearTimeout(this.reloadTimer); this.reloadTimer = undefined;
    if (this.disposed) { return Promise.resolve(); }
    ++this.generation;
    this.reloadRequested = true;
    const project = this.selected;
    this.view.description = project?.name;
    if (project?.uri !== this.displayedUri) {
      this.displayedUri = project?.uri;
      this.items = [];
      this.view.message = project ? t("Loading...") : undefined;
      this.publish();
    }
    if (this.reloading) { return this.loading; }
    this.reloading = true;
    this.loading = (async () => {
      try {
        while (this.reloadRequested && !this.disposed) {
          this.reloadRequested = false;
          await this.load(this.selected, this.projects, this.generation);
        }
      } finally { this.reloading = false; }
    })();
    return this.loading;
  }

  private scheduleReload(): void {
    if (this.disposed) { return; }
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => { void this.reload(); }, 350);
  }

  private publish(): void {
    const signature = JSON.stringify([this.view.description, this.view.message, this.items]);
    if (signature === this.published) { return; }
    this.published = signature;
    this.change.fire();
  }

  private async load(project: Project | undefined, projects: Project[], generation: number): Promise<void> {
    try {
      await this.ready;
      await this.remember(projects.map(entry => ({ id: entry.id, uri: entry.uri, name: entry.name })));
      const relations = project ? readRelatedProjects(await readProjectManifest(vscode.Uri.parse(project.uri))) : [];
      const items = await Promise.all(relations.map(async relation => {
        const imported = await resolveImportedRelatedProject(this.context, relation, project!.uri);
        const detected = imported ? await this.icons?.resolveMany([imported.uri]) : undefined;
        return { ...relation, ownerUri: project!.uri, imported, projectType: detected?.[0]?.projectType, avatarUrl: detected?.[0]?.avatarUrl };
      }));
      if (generation !== this.generation) { return; }
      this.items = items;
      this.view.message = items.length || !project ? undefined : t("No related projects");
    } catch (error) {
      if (generation !== this.generation) { return; }
      this.view.message = t("Unable to read related projects");
      this.output.appendLine(`Related projects: ${String(error)}`);
    }
    this.publish();
    // Runtime bindings also need revalidation when the visible list is unchanged.
    this.bindingsChange.fire();
  }

  private async open(item?: RelatedProjectItem): Promise<void> {
    if (!item || !this.items.some(entry => entry.ownerUri === item.ownerUri && entry.projectId === item.projectId && entry.alias === item.alias)) { return; }
    try {
      let project = await resolveImportedRelatedProject(this.context, item, item.ownerUri);
      if (!project) {
        const action = t("Import Project");
        const answer = await vscode.window.showWarningMessage(t("Related project \"{0}\" has not been imported. Import it first.", item.alias), action);
        if (answer !== action) { return; }
        const folders = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: action });
        if (!folders?.[0]) { return; }
        project = await readImportedProject(folders[0]);
        if (!project || project.id !== item.projectId) {
          await vscode.window.showWarningMessage(t("The selected folder's project UUID does not match the related project."));
          return;
        }
        const registry = readImportedProjects(this.context.globalState.get(IMPORTED_PROJECTS_KEY));
        const downloadRootUri = registry.find(entry => entry.uri === item.ownerUri)?.downloadRootUri;
        if (downloadRootUri) {
          const expected = registry.find(entry => entry.id === item.projectId && entry.downloadRootUri === downloadRootUri)?.version;
          if (expected && project.version !== expected) {
            await vscode.window.showWarningMessage(t("The selected folder's project version does not match the downloaded project group."));
            return;
          }
          project = { ...project, downloadRootUri };
        }
        await this.remember([project]);
        void this.reload();
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(project.uri), { forceNewWindow: true });
    } catch (error) {
      this.output.appendLine(`Related projects: ${String(error)}`);
      await vscode.window.showErrorMessage(t("Unable to open the related project."));
    }
  }

  getChildren(item?: RelatedProjectItem): RelatedProjectItem[] { return item ? [] : this.items; }

  getTreeItem(item: RelatedProjectItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.alias);
    treeItem.id = `${item.ownerUri}:${item.alias}:${item.projectId}`;
    treeItem.description = item.imported ? [item.imported.name, item.imported.version].filter(Boolean).join(' \u00b7 ') : t("Not imported");
    treeItem.tooltip = `${item.alias}\n${item.projectId}\n${item.imported ? vscode.Uri.parse(item.imported.uri).fsPath : t("Not imported")}`;
    treeItem.iconPath = item.avatarUrl ? vscode.Uri.parse(item.avatarUrl)
      : new vscode.ThemeIcon(item.projectType ? projectTypeIcons[item.projectType] : item.imported ? 'folder' : 'link');
    treeItem.contextValue = item.imported ? 'studio.relatedProjectImported' : 'studio.relatedProjectMissing';
    treeItem.command = { command: 'studio.openRelatedProject', title: t("Open Related Project in New Window"), arguments: [item] };
    return treeItem;
  }

  dispose(): void { this.disposed = true; ++this.generation; clearTimeout(this.reloadTimer); this.change.dispose(); this.bindingsChange.dispose(); }
}
