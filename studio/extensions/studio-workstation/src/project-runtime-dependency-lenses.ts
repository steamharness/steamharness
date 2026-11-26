import * as vscode from 'vscode';
import { findNodeAtLocation, parseTree } from 'jsonc-parser/lib/esm/main.js';
import { t } from './localization';
import type { Launcher } from './workflow-cli-types';
import type { RuntimeArchiveInspection, RuntimeDependencyCandidate, RuntimeDependencyInspection } from './project-runtime-dependencies-node';
import type { RuntimeNpmUpdate } from './project-runtime-npm-node';
import type { ProjectDependencyProgress } from './project-dependency-progress';

const replaceCommand = 'studio.internalReplaceRuntimeDependencies';
const stale = 'The project dependencies or Studio bundle changed. Refresh the comparison and try again.';

function comparisonLabel(result: RuntimeArchiveInspection): string {
  if (!result.bundleVersion) return t('Studio runtime bundle unavailable');
  if (result.packages.some(pkg => !pkg.projectSha256)) return t('Project runtime archive unavailable');
  if (result.packages.some(pkg => !pkg.sameArchive)) {
    return result.packages.every(pkg => pkg.version === result.bundleVersion)
      ? t('Same version, different archives') : t('Runtime archives differ');
  }
  if (result.matches) return t('Runtime matches Studio');
  return result.manager ? t('Archives match; installation needs refresh') : t('Runtime archives match');
}

function comparisonTooltip(result: RuntimeArchiveInspection, label: string): string {
  const [core, cli] = result.packages;
  const unavailable = t('Unavailable');
  const lines = [label, t('Project: Core {0}, CLI {1} | Studio: {2}', core.version ?? unavailable, cli.version ?? unavailable, result.bundleVersion ?? unavailable),
    t('Installed: Core {0}, CLI {1}', core.installedVersion ?? unavailable, cli.installedVersion ?? unavailable)];
  for (const pkg of [core, cli]) {
    if (!pkg.projectSha256 && !pkg.studioSha256) continue;
    lines.push('', pkg.name, t('Project SHA-256: {0}', pkg.projectSha256 ?? unavailable), t('Studio SHA-256: {0}', pkg.studioSha256 ?? unavailable));
  }
  if (result.bundleVersion && !result.manager && !result.matches) {
    lines.push('', t('This project installation does not support in-place runtime replacement.'));
  }
  return lines.join('\n');
}

function npmUpdateLabel(update: RuntimeNpmUpdate): string { return t('npm update available: {0}', update.latestVersion); }

function npmUpdateTooltip(update: RuntimeNpmUpdate): string {
  return [npmUpdateLabel(update), t('Declared version or range: {0}', update.spec), t('Installed version: {0}', update.installedVersion ?? t('Unavailable')),
    update.kind === 'declaration' ? t('The npm release is newer than the declared range.')
      : t('The declared range already allows this release. Only the installation needs updating.')].join('\n');
}

export function registerRuntimeDependencyIndicators(context: vscode.ExtensionContext, service: NonNullable<Launcher['runtimeDependencies']>,
  prepare: (directory: string, signal: AbortSignal) => Promise<vscode.Disposable>, output: vscode.OutputChannel,
  dependencyProgress: ProjectDependencyProgress, currentManifest: () => vscode.Uri | undefined): () => void {
  const changed = new vscode.EventEmitter<void>(), lifetime = new AbortController();
  const status = vscode.window.createStatusBarItem('projectRuntimeDependencies', vscode.StatusBarAlignment.Left, 110);
  status.name = t('Runtime Dependencies');
  const replacing = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const target = (uri: vscode.Uri) => {
    if (!vscode.workspace.isTrusted || uri.scheme !== 'file' || !uri.path.endsWith('/package.json')) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder?.uri.scheme === 'file') return { directory: vscode.Uri.joinPath(uri, '..').fsPath, workspace: folder.uri.fsPath };
  };
  const targetKey = ({ directory, workspace }: RuntimeDependencyCandidate) => `${workspace}\0${directory}`;
  const pending = new Map<string, Promise<RuntimeDependencyInspection | undefined>>();
  let batch = new AbortController();
  const inspectForDisplay = (candidate: RuntimeDependencyCandidate) => {
    const key = targetKey(candidate), cached = pending.get(key);
    if (cached) return cached;
    const signal = batch.signal;
    const read = service.inspect(candidate, signal).then(result => { signal.throwIfAborted(); return result; })
      .finally(() => { if (pending.get(key) === read) pending.delete(key); });
    pending.set(key, read);
    return read;
  };
  let statusTarget: string | undefined, statusGeneration = 0;
  const updateStatus = async (force = false): Promise<void> => {
    if (lifetime.signal.aborted) return;
    const uri = currentManifest(), candidate = uri && target(uri), key = candidate && targetKey(candidate);
    if (!force && key === statusTarget) return;
    if (key !== statusTarget) status.hide();
    statusTarget = key;
    const generation = ++statusGeneration;
    if (!uri || !candidate) return;
    const result = await inspectForDisplay(candidate).catch(() => undefined);
    const selected = currentManifest(), selectedTarget = selected && target(selected);
    if (lifetime.signal.aborted || generation !== statusGeneration || !selectedTarget || targetKey(selectedTarget) !== key) return;
    if (!result) { status.hide(); return; }
    if (result.kind === 'npm') {
      const [first] = result.updates;
      if (!first) { status.hide(); return; }
      const label = result.updates.every(update => update.latestVersion === first.latestVersion) ? npmUpdateLabel(first) : t('Runtime updates available');
      status.text = `$(arrow-circle-up) ${label}`;
      status.tooltip = result.updates.map(update => `${update.name}\n${npmUpdateTooltip(update)}`).join('\n\n');
    } else {
      const label = comparisonLabel(result), version = result.packages[0].version;
      const archivesDiffer = result.packages.some(pkg => !pkg.sameArchive);
      const attention = result.bundleVersion && !result.matches && (result.manager || archivesDiffer);
      const sameVersion = version && result.packages.every(pkg => pkg.version === version);
      const canUpgradeBuild = attention && result.manager && archivesDiffer && sameVersion && version === result.bundleVersion;
      status.text = canUpgradeBuild ? `$(arrow-circle-up) ${t('Runtime updates available')}`
        : attention ? `$(warning) ${label}` : `$(package) ${sameVersion ? t('Runtime {0}', version) : status.name}`;
      status.tooltip = comparisonTooltip(result, label);
    }
    status.command = { command: 'vscode.open', title: t('Open package.json'), arguments: [uri] };
    status.show();
  };
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      batch.abort(); batch = new AbortController(); pending.clear();
      changed.fire(); void updateStatus(true);
    }, 120);
  };
  const watch = (glob: vscode.GlobPattern, filter: (uri: vscode.Uri) => boolean) => {
    const watcher = vscode.workspace.createFileSystemWatcher(glob), update = (uri: vscode.Uri) => { if (filter(uri)) refresh(); };
    context.subscriptions.push(watcher, watcher.onDidChange(update), watcher.onDidCreate(update), watcher.onDidDelete(update));
  };
  watch('**/{package.json,steamharness.json,pnpm-lock.yaml,package-lock.json,npm-shrinkwrap.json,*.tgz}', uri => !uri.path.includes('/node_modules/'));
  if (service.bundleDirectory) {
    const bundle = vscode.Uri.file(service.bundleDirectory);
    // Runtime packing replaces the whole bundle directory.
    watch(new vscode.RelativePattern(vscode.Uri.joinPath(bundle, '..'), '{*,*/runtime-packages.json,*/steamharness.tgz,*/steamharness-cli.tgz}'),
      uri => uri.path === bundle.path || uri.path.startsWith(`${bundle.path}/`));
  }
  context.subscriptions.push(changed, status,
    vscode.workspace.onDidGrantWorkspaceTrust(refresh), vscode.window.onDidChangeWindowState(state => { if (state.focused) refresh(); }),
    { dispose: () => { lifetime.abort(); batch.abort(); clearTimeout(timer); } },
    vscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: '**/package.json' }, {
      onDidChangeCodeLenses: changed.event,
      async provideCodeLenses(document, token) {
        const candidate = target(document.uri), generation = document.version;
        if (!candidate || document.isDirty || token.isCancellationRequested) return [];
        try {
          const tree = parseTree(document.getText());
          if (!tree || !['dependencies', 'devDependencies'].some(group => ['steamharness', '@steamharness/cli'].some(name => findNodeAtLocation(tree, [group, name])))) return [];
          const result = await inspectForDisplay(candidate);
          if (!result || token.isCancellationRequested || document.version !== generation || document.isDirty || !target(document.uri)) return [];
          const dependencyRange = (group: string, name: string) => {
            const anchor = findNodeAtLocation(tree, [group, name]);
            if (anchor) {
              const position = document.positionAt(anchor.parent?.offset ?? anchor.offset);
              return new vscode.Range(position, position);
            }
          };
          if (result.kind === 'npm') return result.updates.flatMap(update => {
            const range = dependencyRange(update.group, update.name);
            return range ? [new vscode.CodeLens(range, { title: npmUpdateLabel(update), command: '', tooltip: npmUpdateTooltip(update) })] : [];
          });
          const range = dependencyRange(result.packages[0].group, result.packages[0].name);
          if (!range) return [];
          const status = comparisonLabel(result);
          const lenses = [new vscode.CodeLens(range, { title: status, command: '', tooltip: comparisonTooltip(result, status) })];
          if (result.bundleVersion && result.manager && !result.matches && !replacing.has(document.uri.toString())) {
            lenses.push(new vscode.CodeLens(range, { title: t('Use Studio runtime dependencies'), command: replaceCommand, tooltip: status,
              arguments: [document.uri.toString(), result.revision] }));
          }
          return lenses;
        } catch { return []; }
      },
    }),
    vscode.commands.registerCommand(replaceCommand, async (address: unknown, revision: unknown) => {
      if (typeof address !== 'string' || !address.startsWith('file:') || typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision)) return;
      const uri = vscode.Uri.parse(address, true);
      const candidate = target(uri), key = uri.toString();
      if (!candidate || replacing.has(key)) return;
      const unsaved = () => vscode.workspace.textDocuments.some(document => document.uri.toString() === key && document.isDirty);
      replacing.add(key); refresh();
      let started = false;
      try {
        if (unsaved()) throw new Error(t('Save package.json before replacing runtime dependencies.'));
        const result = await service.inspect(candidate, lifetime.signal);
        if (result?.kind !== 'archive' || result.revision !== revision || !result.bundleVersion || !result.manager) throw new Error(t(stale));
        if (result.matches) return;
        const archivesMatch = result.packages.every(pkg => pkg.sameArchive);
        const use = archivesMatch ? t('Reinstall') : t('Replace and install');
        const description = archivesMatch
          ? t('Studio will close running project views that use this folder and reinstall dependencies without changing the archives.')
          : t('Studio will close running project views that use this folder, replace both local archives, and reinstall dependencies.');
        if (await vscode.window.showWarningMessage(t('Use Studio Core and CLI {0} for this project?', result.bundleVersion), {
          modal: true, detail: `${comparisonLabel(result)}\n\n${description}`,
        }, use) !== use) return;
        if (!target(uri) || unsaved()) throw new Error(t('Save package.json before replacing runtime dependencies.'));
        started = true;
        await dependencyProgress.run({ title: archivesMatch ? t('Reinstalling Studio runtime dependencies') : t('Replacing Studio runtime dependencies'),
          directory: candidate.directory, signal: lifetime.signal, describeError: error => t('Could not replace runtime dependencies: {0}', error instanceof Error ? error.message : String(error)) },
          async ({ signal, append }) => {
            let release: vscode.Disposable | undefined;
            try {
              const version = await service.replace(candidate, revision, signal, async directory => {
                if (!target(uri) || unsaved()) throw new Error(t('Save package.json before replacing runtime dependencies.'));
                release = await prepare(directory, signal);
              }, chunk => { output.append(chunk); append(chunk); });
              append(`\n${t('Installed Studio Core and CLI {0}.', version)}\n`);
            } finally { release?.dispose(); }
          });
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          output.appendLine(String(error));
          if (!started) void vscode.window.showErrorMessage(t('Could not replace runtime dependencies: {0}', error instanceof Error ? error.message : String(error)));
        }
      } finally { replacing.delete(key); refresh(); }
    }));
  return () => { void updateStatus(); };
}
