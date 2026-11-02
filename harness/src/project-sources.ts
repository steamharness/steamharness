import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Only the registered module and its relative imports belong to this entry. */
export function projectEntrySources(projectDir: string, entryFile: string): string[] {
  const root = realpathSync(projectDir);
  const files = new Set<string>();
  const scan = (file: string, dependency = false): void => {
    const resolved = realpathSync(file);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Entry source escapes its declared root.");
    // Generated model/engine code is a dependency, not a workflow definition.
    // In particular its types and WASM glue must not enter declaration checks.
    const parts = relative.split(path.sep);
    if (dependency && parts[0] === ".steamharness" && parts[1] === "generated" && parts[2] === "database") return;
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
