import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** Keep the public extension API typed without installing the bundled Pi runtime again. */
export async function bundleAgentTypes(directory) {
  const production = new Set(Object.keys(JSON.parse(await readFile(path.join(directory, "../package.json"), "utf8")).dependencies));
  const copied = new Map();
  const compilerOptions = { module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022 };
  const printer = ts.createPrinter();
  const packageName = specifier => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  const rewrite = async (sourcePath, outputPath, recursive) => {
    const content = await readFile(sourcePath, "utf8");
    const source = ts.createSourceFile(sourcePath, content, ts.ScriptTarget.Latest, true);
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
      if (!recursive && !/^@(earendil-works|modelcontextprotocol)\//.test(specifier)) continue;
      const resolved = ts.resolveModuleName(specifier, sourcePath, compilerOptions, ts.sys, undefined, undefined, ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName;
      if (!resolved) {
        // Provider SDKs deliberately probe optional fetch types under @ts-ignore.
        let statement = literal;
        while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
        const leading = content.slice(statement.getFullStart(), statement.getStart(source));
        if (/\/\/\s*@ts-ignore\b/.test(leading)) continue;
        throw new Error(`Cannot bundle declaration module ${specifier} from ${sourcePath}`);
      }
      if (!/\.d\.[cm]?ts$/.test(resolved)) throw new Error(`Expected a declaration file for ${specifier}: ${resolved}`);
      let target = copied.get(resolved);
      if (!target) {
        const normalized = resolved.replaceAll("\\", "/");
        const identity = normalized.slice(normalized.indexOf("/node_modules/") + 14);
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
