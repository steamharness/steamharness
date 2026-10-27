import * as vscode from 'vscode';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { AssistantWorkspaceFolder, Project } from './workflow-types';
import { projectId } from './projects';
import { readPackageManifest } from './project-catalog';
import { readProjectManifest as parseProjectManifest, selectProjectEntry } from '@steamharness/project-manifest';
import type { StudioControlPermissionPolicy } from './studio-control-bridge';
import { t } from './localization';

const views: Record<string, string> = {
  explorer: 'workbench.view.explorer', search: 'workbench.view.search',
  'source-control': 'workbench.view.scm', terminal: 'workbench.action.terminal.focus',
  assistant: 'studio.openAssistant',
};
const operations = ['studio.configurations.get', 'studio.configurations.manage', 'studio.configurations.open', 'studio.state.get', 'studio.entries.get', 'studio.file.open', 'studio.diagnostics.get', 'studio.theme.set', 'studio.terminal.open', 'studio.view.show'];

export const STUDIO_CONTROL_ENTRY_ID = 'studio-control';

function contains(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function studioControlWorkspaceAvailable(scope: NonNullable<Project['assistant']>, folders: AssistantWorkspaceFolder[]): boolean {
  return scope.roots.some(root => contains(root.folderPath, scope.workdir))
    && scope.roots.every(root => folders.some(folder => folder.uri === root.uri && folder.folderPath === root.folderPath));
}

export function createStudioControlHandler(assistant: NonNullable<Project['assistant']>, signal: AbortSignal, _context: Pick<vscode.ExtensionContext, 'globalState'>, services?: {
  configuration(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}) {
  const installedThemes = (): string[] => [...new Set(vscode.extensions.all.flatMap(extension =>
    (extension.packageJSON?.contributes?.themes ?? []).flatMap((theme: { id?: string; label?: string }) =>
      typeof (theme.id ?? theme.label) === 'string' ? [theme.id ?? theme.label as string] : [])))].sort();
  const assertAvailable = (): void => {
    signal.throwIfAborted();
    if (!vscode.workspace.isTrusted) { throw new Error(t('Trust the current workspace first.')); }
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
      .map(folder => ({ uri: folder.uri.toString(), folderPath: folder.uri.fsPath, name: folder.name }));
    if (!studioControlWorkspaceAvailable(assistant, folders)) { throw new Error(t('Studio Control workspace is no longer available.')); }
  };

  return async (operation: string, input: Record<string, unknown>, permissionPolicy: StudioControlPermissionPolicy = 'workspace'): Promise<unknown> => {
    assertAvailable();
    const allowedPath = async (filename: string): Promise<string> => {
      const candidate = await realpath(path.resolve(assistant.workdir, filename));
      if (permissionPolicy !== 'auto') {
        const roots = await Promise.all(assistant.roots.map(root => realpath(root.folderPath)));
        if (!roots.some(root => contains(root, candidate))) { throw new Error(t('Studio Control can only access the registered workspace folders.')); }
      }
      assertAvailable();
      return candidate;
    };
    const keys: Record<string, string[]> = {
      'studio.configurations.get': ['storage', 'projectDir', 'projectId', 'entryId', 'target', 'id', 'export', 'preview'],
      'studio.configurations.manage': ['storage', 'projectDir', 'projectId', 'entryId', 'target', 'call'],
      'studio.configurations.open': ['storage', 'projectDir', 'projectId', 'entryId', 'target'],
      'studio.state.get': [], 'studio.entries.get': ['projectDir'], 'studio.file.open': ['filePath', 'line', 'column'],
      'studio.diagnostics.get': ['filePath'], 'studio.theme.set': ['theme'],
      'studio.terminal.open': ['cwd'], 'studio.view.show': ['view'],
    };
    if (!Object.hasOwn(keys, operation) || Object.keys(input).some(key => !keys[operation].includes(key))) {
      throw new Error(t('Unsupported Studio Control operation or parameters.'));
    }
    const requiredString = (key: string): string => {
      if (typeof input[key] !== 'string' || !input[key].trim()) { throw new Error(t('Invalid Studio Control parameter: {0}', key)); }
      return input[key].trim();
    };
    const optionalString = (key: string): string | undefined => input[key] === undefined ? undefined : requiredString(key);
    const position = (key: string): number | undefined => {
      if (input[key] === undefined) { return undefined; }
      if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 1) { throw new Error(t('Invalid Studio Control parameter: {0}', key)); }
      return input[key] as number;
    };
    switch (operation) {
      case 'studio.configurations.get': case 'studio.configurations.manage': case 'studio.configurations.open': {
        if (!['local','server'].includes(requiredString('storage'))) throw new Error(t('Invalid configuration storage.'));
        const reading = operation === 'studio.configurations.get';
        if (operation === 'studio.configurations.manage' && permissionPolicy === 'read-only') throw new Error(t('Read-only mode does not allow configuration changes.'));
        const requestedTarget=optionalString('target');
        if(input.storage==='local'&&requestedTarget!==undefined)throw new Error(t('Use target only for Server configurations.'));
        if(input.preview!==undefined&&typeof input.preview!=='boolean'||input.preview===true&&input.export===true)throw new Error(t('Invalid configuration action.'));
        if(input.export!==undefined&&typeof input.export!=='boolean')throw new Error(t('Invalid configuration action.'));
        const entryId = requiredString('entryId');
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(entryId)) throw new Error(t('Invalid project entry identifier.'));
        const target: Record<string,unknown> = {storage:input.storage,entryId,...(requestedTarget?{target:requestedTarget}:{})};
        if(input.storage==='local') {
          if(input.projectId!==undefined) throw new Error(t('Use projectDir for local configurations.'));
          const directory=await allowedPath(requiredString('projectDir'));
          if(!(await stat(directory)).isDirectory())throw new Error(t('Studio Control requires a directory.'));
          await allowedPath(path.join(directory,'package.json'));
          try { await allowedPath(path.join(directory,'configuration.json')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const manifest=await readPackageManifest(vscode.Uri.file(directory));
          if(!projectId((manifest as {id?:unknown}|null)?.id))throw new Error(t('Studio Control requires a Workflow project directory.'));
          selectProjectEntry(parseProjectManifest(manifest), entryId);
          target.projectDir=directory;
        } else {
          if(input.projectDir!==undefined)throw new Error(t('Use projectId for Server configurations.'));
          target.target=requiredString('target');
          const id=requiredString('projectId').toLowerCase();
          if(!projectId(id))throw new Error(t('Invalid project identifier.'));
          if(permissionPolicy!=='auto') {
            const allowed=new Set<string>();
            for(const root of assistant.roots) {
              const manifest=await readPackageManifest(vscode.Uri.file(root.folderPath));
              const own=projectId((manifest as {id?:unknown}|null)?.id);if(own)allowed.add(own.toLowerCase());
            }
            if(!allowed.has(id))throw new Error(t('Server project must belong to the registered workspace.'));
          }
          target.projectId=id;
        }
        assertAvailable();
        if(!services)throw new Error(t('Project configurations are unavailable.'));
        if(operation==='studio.configurations.open')return services.configuration({...target,open:true},signal);
        const call=reading?{action:input.preview===true?'publication.preview':input.export===true?'export':'get',id:optionalString('id')}:input.call;
        if(!call||typeof call!=='object'||Array.isArray(call))throw new Error(t('Invalid configuration action.'));
        if(!reading) {
          const action=(call as Record<string,unknown>).action,revision=(call as Record<string,unknown>).revision;
          if(['get','export'].includes(String(action)))throw new Error(t('Use the configuration query tool for reads.'));
          if(!['create','duplicate','rename','save','select','delete','field.save','field.delete','import','publication.save','publication.preview'].includes(String(action)) || !Number.isSafeInteger(revision) || Number(revision)<0)throw new Error(t('Invalid configuration action.'));
        }
        return services.configuration({...target,call},signal);
      }

      case 'studio.state.get': {
        let activeEditor: unknown = null;
        const editor = vscode.window.activeTextEditor;
        if (editor?.document.uri.scheme === 'file') {
          try {
            const filePath = await allowedPath(editor.document.uri.fsPath);
            activeEditor = { filePath, languageId: editor.document.languageId, dirty: editor.document.isDirty,
              line: editor.selection.active.line + 1, column: editor.selection.active.character + 1 };
          } catch { /* An editor outside this assistant's scope is not exposed. */ }
        }
        assertAvailable();
        return { appName: vscode.env.appName, vscodeVersion: vscode.version, language: vscode.env.language,
          workdir: assistant.workdir, folders: assistant.roots, activeEditor, permissionPolicy, pathAccess: permissionPolicy === 'auto' ? 'all' : 'workspace',
          theme: vscode.workspace.getConfiguration('workbench').get<string>('colorTheme'),
          themes: installedThemes(), views: Object.keys(views), operations };
      }
      case 'studio.entries.get': {
        const directory = await allowedPath(optionalString('projectDir') ?? assistant.workdir);
        if (!(await stat(directory)).isDirectory()) { throw new Error(t('Studio Control requires a directory.')); }
        await allowedPath(path.join(directory, 'package.json'));
        const manifest = await readPackageManifest(vscode.Uri.file(directory));
        const id = projectId((manifest as { id?: unknown } | null)?.id);
        if (!id) { throw new Error(t('Studio Control requires a Workflow project directory.')); }
        const aggregate = parseProjectManifest(manifest);
        assertAvailable();
        return { projectId: id, projectDir: directory, entries: aggregate.entries, defaultEntry: aggregate.defaultEntry };
      }
      case 'studio.file.open': {
        const line = position('line'), column = position('column');
        const filename = await allowedPath(requiredString('filePath'));
        if (!(await stat(filename)).isFile()) { throw new Error(t('Studio Control requires a file.')); }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
        assertAvailable();
        const target = line !== undefined || column !== undefined
          ? document.validatePosition(new vscode.Position((line ?? 1) - 1, (column ?? 1) - 1)) : undefined;
        const editor = await vscode.window.showTextDocument(document, { preview: false,
          ...(target ? { selection: new vscode.Range(target, target) } : {}) });
        return { filePath: filename, line: editor.selection.active.line + 1, column: editor.selection.active.character + 1 };
      }
      case 'studio.diagnostics.get': {
        const requested = optionalString('filePath');
        const filename = requested === undefined ? undefined : await allowedPath(requested);
        const all = vscode.languages.getDiagnostics();
        const diagnostics = [];
        let total = 0;
        for (const [uri, entries] of all) {
          if (uri.scheme !== 'file') { continue; }
          let filePath: string;
          try { filePath = await allowedPath(uri.fsPath); } catch { continue; }
          if (filename !== undefined && filePath !== filename) { continue; }
          total += entries.length;
          for (const entry of entries.slice(0, Math.max(0, 200 - diagnostics.length))) {
            diagnostics.push({ filePath, message: entry.message.slice(0, 4_000), source: entry.source, code: entry.code,
              severity: ['error', 'warning', 'information', 'hint'][entry.severity],
              line: entry.range.start.line + 1, column: entry.range.start.character + 1,
              endLine: entry.range.end.line + 1, endColumn: entry.range.end.character + 1 });
          }
        }
        assertAvailable();
        return { diagnostics, total, truncated: total > diagnostics.length };
      }
      case 'studio.theme.set': {
        const theme = requiredString('theme');
        if (!installedThemes().includes(theme)) { throw new Error(t('Studio Control requires an installed color theme.')); }
        const update = async (configuration: vscode.WorkspaceConfiguration, key: string, value: unknown): Promise<void> => {
          assertAvailable();
          const target = configuration.inspect(key)?.workspaceValue === undefined
            ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
          await configuration.update(key, value, target);
        };
        await update(vscode.workspace.getConfiguration('workbench'), 'colorTheme', theme);
        const window = vscode.workspace.getConfiguration('window');
        for (const key of ['autoDetectColorScheme', 'autoDetectHighContrast']) {
          if (window.get<boolean>(key)) { await update(window, key, false); }
        }
        assertAvailable();
        return { theme, mode: 'manual' };
      }
      case 'studio.terminal.open': {
        const cwd = await allowedPath(optionalString('cwd') ?? assistant.workdir);
        if (!(await stat(cwd)).isDirectory()) { throw new Error(t('Studio Control requires a directory.')); }
        assertAvailable();
        const terminal = vscode.window.createTerminal({ name: t('Studio terminal'), cwd });
        terminal.show(true);
        return { name: terminal.name, cwd };
      }
      case 'studio.view.show': {
        const view = requiredString('view');
        if (!Object.hasOwn(views, view)) { throw new Error(t('Unsupported Studio Control view.')); }
        await vscode.commands.executeCommand(views[view]);
        return { view };
      }
    }
  };
}
