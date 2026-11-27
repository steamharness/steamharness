import { t } from './localization';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readProjectReleaseSync } from '@steamharness/project-manifest/release-node';
import { resolveProjectCli } from './workflow-cli-process';
import { localAccountsDirectory, localProjectDirectory, prepareLocalDirectory } from '@steamharness/project-manifest/node';

const assistantId = 'a3aca697-b086-459b-84e4-d357ad2d9fb2';
export const ANALYSIS_PROJECT_ID = '6cbe3c24-2707-4f31-a553-94edbe866eb1';

interface BuiltinApplicationOptions { templateDir: string; storageDir: string; dependencySources: string[] }

export function prepareAssistantApplication(options: BuiltinApplicationOptions): Promise<string> {
  return prepareBuiltinApplication(options, assistantId);
}

export function prepareAnalysisApplication(options: BuiltinApplicationOptions): Promise<string> {
  return prepareBuiltinApplication(options, ANALYSIS_PROJECT_ID);
}

export async function prepareBuiltinApplication(options: BuiltinApplicationOptions, projectId: string): Promise<string> {
  // The extended Dev build links the template root into its extension overlay.
  const template = await realpath(options.templateDir);
  const nested = path.join(template, 'project');
  const hasNestedRelease = (await stat(nested).catch(() => undefined))?.isDirectory();
  const projectRoot = hasNestedRelease ? nested : template;
  const release = readProjectReleaseSync(projectRoot);
  if (hasNestedRelease && !release || !release && projectId !== assistantId && projectId !== ANALYSIS_PROJECT_ID) throw new Error('Invalid built-in release.');
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const project = JSON.parse(await readFile(path.join(projectRoot, 'steamharness.json'), 'utf8'));
  if (project.id !== projectId) { throw new Error('Invalid built-in project.'); }
  let dependencies: { directory: string; harnessVersion: string; cliVersion: string } | undefined;
  for (const source of options.dependencySources) {
    try {
      const pkg = JSON.parse(await readFile(path.join(source, 'steamharness.json'), 'utf8'));
      if (pkg.id !== assistantId) { continue; }
      const cli = await resolveProjectCli(source);
      const directory = await realpath(path.join(source, 'node_modules'));
      const harness = JSON.parse(await readFile(path.join(directory, 'steamharness', 'package.json'), 'utf8'));
      if (harness.name === 'steamharness' && typeof harness.version === 'string'
        && (!release || manifest.devDependencies?.steamharness === harness.version && manifest.devDependencies?.['@steamharness/cli'] === cli.version)) {
        dependencies = { directory, harnessVersion: harness.version, cliVersion: cli.version }; break;
      }
    } catch { /* Only the independent assistant's installations are eligible. */ }
  }
  if (!dependencies) { throw new Error(t("Standalone Assistant dependencies are missing. Install build-in-developer-assistant dependencies and build its CLI.")); }
  const digest = createHash('sha256').update(JSON.stringify({ formatVersion: 1, ...dependencies }));
  const fingerprint = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      digest.update(entry.name);
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { await fingerprint(filename); }
      else if (entry.isFile()) { digest.update(await readFile(filename)); }
    }
  };
  await fingerprint(template);
  const directory = path.join(localProjectDirectory(options.storageDir, projectId), 'builds', digest.digest('hex').slice(0, 24));
  const projectDirectory = hasNestedRelease ? path.join(directory, 'project') : directory;
  const verify = async () => {
    if (await realpath(path.join(projectDirectory, 'node_modules')) !== dependencies.directory) throw new Error('Unexpected built-in project runtime.');
    if (release && readProjectReleaseSync(projectDirectory)?.buildId !== release.buildId) throw new Error('Invalid installed built-in release.');
    await resolveProjectCli(projectDirectory);
  };
  try { await verify(); return projectDirectory; } catch { /* Create this immutable template version once. */ }
  if (path.dirname(options.storageDir) === localAccountsDirectory()) prepareLocalDirectory(path.dirname(directory));
  else await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(path.dirname(directory), 'prepare-'));
  try {
    await cp(template, staging, { recursive: true });
    const root = hasNestedRelease ? path.join(staging, 'project') : staging;
    // The app owns its runtime. No dependency is resolved from an opened folder.
    await symlink(dependencies.directory, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    if (!release) {
      const installed = { ...manifest, scripts: undefined, dependencies: undefined,
        devDependencies: { 'steamharness': dependencies.harnessVersion, '@steamharness/cli': dependencies.cliVersion } };
      await writeFile(path.join(root, 'package.json'), `${JSON.stringify(installed, null, 2)}\n`);
    }
    try { await rename(staging, directory); }
    catch (error) {
      try { await verify(); }
      catch { throw error; }
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return projectDirectory;
}
