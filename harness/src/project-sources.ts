import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Only the registered module and its relative imports belong to this entry. */
export function projectEntrySources(projectDir: string, entryFile: string): string[] {
  const root = realpathSync(projectDir);
  const files = new Set<string>();
  const scan = (file: string): void => {
    const resolved = realpathSync(file);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Entry source escapes its declared root.");
    if (files.has(resolved)) return;
    files.add(resolved);
    const imports = ts.preProcessFile(readFileSync(resolved, "utf8"), true, true).importedFiles;
    for (const imported of imports) {
    if (!imported.fileName.startsWith(".")) continue;
    const module = ts.resolveModuleName(imported.fileName, resolved, { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true }, ts.sys).resolvedModule;
    if (module && !module.isExternalLibraryImport && !module.resolvedFileName.endsWith(".d.ts")) scan(module.resolvedFileName);
    }
  };
  scan(entryFile);
  return [...files].sort();
}
