import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export function sharedSourcePath(shared, file, paths = path) {
  // TypeScript returns forward-slash paths even on Windows.
  const relative = paths.relative(shared, file);
  if (!relative || relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return null;
  return /\.[cm]?tsx?$/u.test(relative) ? relative.split(paths.sep).join("/") : null;
}

/** Keep the public API typed without installing bundled build-time packages. */
export async function bundleAgentTypes(directory) {
  const production = new Set(Object.keys(JSON.parse(await readFile(path.join(directory, "../package.json"), "utf8")).dependencies));
  const copied = new Map();
  const compilerOptions = { module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022 };
  const shared = path.resolve(directory, '../../shared');
  const printer = ts.createPrinter();
  const packageName = specifier => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  const declarationText = async (file) => {
    if (/\.d\.[cm]?ts$/u.test(file)) return readFile(file, 'utf8');
    if (!sharedSourcePath(shared, file)) throw new Error(`Expected a declaration file: ${file}`);
    const program = ts.createProgram([file], { ...compilerOptions, declaration: true, emitDeclarationOnly: true, skipLibCheck: true, types: [] });
    let text;
    const result = program.emit(program.getSourceFile(file), (name, content) => {
      if (/\.d\.[cm]?ts$/u.test(name)) text = content;
    }, undefined, true);
    if (result.emitSkipped || text === undefined) throw new Error(`Cannot emit shared declarations for ${file}`);
    return text;
  };
  const rewrite = async (sourcePath, outputPath, recursive) => {
    const content = await declarationText(sourcePath);
    const source = ts.createSourceFile(outputPath, content, ts.ScriptTarget.Latest, true);
    const literals = [];
    const collect = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) literals.push(node.moduleSpecifier);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) literals.push(node.argument.literal);
      ts.forEachChild(node, collect);
    };
    collect(source);
    const replacements = new Map();
    for (const literal of literals) {
      const specifier = literal.text;
      if (specifier.startsWith("node:") || builtinModules.includes(specifier) || production.has(packageName(specifier))) continue;
      if (!recursive && !/^@(earendil-works|modelcontextprotocol|steamharness)\//.test(specifier)) continue;
      const resolved = ts.resolveModuleName(specifier, sourcePath, compilerOptions, ts.sys, undefined, undefined, ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName;
      if (!resolved) {
        // Provider SDKs deliberately probe optional fetch types under @ts-ignore.
        let statement = literal;
        while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
        const leading = content.slice(statement.getFullStart(), statement.getStart(source));
        if (/\/\/\s*@ts-ignore\b/.test(leading)) continue;
        throw new Error(`Cannot bundle declaration module ${specifier} from ${sourcePath}`);
      }
      let target = copied.get(resolved);
      if (!target) {
        const normalized = resolved.replaceAll("\\", "/");
        const workspaceSource = sharedSourcePath(shared, resolved);
        const identity = workspaceSource ? `shared/${workspaceSource}`
          : normalized.slice(normalized.indexOf("/node_modules/") + 14);
        target = path.join(directory, "agent-types", `${createHash("sha256").update(identity).digest("hex").slice(0, 20)}.d.ts`);
        copied.set(resolved, target);
        await rewrite(resolved, target, true);
      }
      let relative = path.relative(path.dirname(outputPath), target).replaceAll("\\", "/").replace(/\.d\.ts$/, ".js");
      if (!relative.startsWith(".")) relative = `./${relative}`;
      replacements.set(literal, relative);
    }
    if (!recursive && !replacements.size) return;
    const transformed = ts.transform(source, [context => node => {
      const visit = child => replacements.has(child) ? ts.factory.createStringLiteral(replacements.get(child)) : ts.visitEachChild(child, visit, context);
      return ts.visitNode(node, visit);
    }]);
    try {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, printer.printFile(transformed.transformed[0]).replace(/^\/\/# sourceMappingURL=.*$/gm, ""));
    } finally { transformed.dispose(); }
  };
  const entries = await readdir(directory, { recursive: true });
  for (const entry of entries.filter(entry => entry.endsWith(".d.ts") && !entry.startsWith(`agent-types${path.sep}`))) {
    const file = path.join(directory, entry);
    await rewrite(file, file, false);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await bundleAgentTypes(path.resolve("dist"));
}
