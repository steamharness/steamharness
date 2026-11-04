import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { databaseArtifactDirectory } from "@steamharness/project-manifest";
import ts from "typescript";

/** Only the registered module and its relative imports belong to this entry. */
export function projectEntrySources(projectDir: string, entryFile: string, aggregateDir = projectDir): string[] {
  const root = realpathSync(projectDir);
  const aggregateRoot = realpathSync(aggregateDir);
  const sourceRoot = path.relative(aggregateRoot, root).split(path.sep).join("/") || ".";
  const generated = path.resolve(aggregateRoot, databaseArtifactDirectory(sourceRoot));
  const files = new Set<string>();
  const scan = (file: string, dependency = false): void => {
    const resolved = realpathSync(file);
    const relative = path.relative(root, resolved);
    const generatedRelative = path.relative(generated, resolved);
    if (dependency && generatedRelative && generatedRelative !== ".." && !generatedRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(generatedRelative)) return;
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Entry source escapes its declared root.");
    if (files.has(resolved)) return;
    files.add(resolved);
    const imports = ts.preProcessFile(readFileSync(resolved, "utf8"), true, true).importedFiles;
    for (const imported of imports) {
    if (!imported.fileName.startsWith(".")) continue;
    const module = ts.resolveModuleName(imported.fileName, resolved, { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true }, ts.sys).resolvedModule;
    if (module && !module.isExternalLibraryImport && !module.resolvedFileName.endsWith(".d.ts")) scan(module.resolvedFileName, true);
    }
  };
  scan(entryFile);
  return [...files].sort();
}
