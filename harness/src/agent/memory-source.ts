import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Follow static executor exports without importing or running project code. */
export function findBotMemoryDefinition(entryFile: string, files: readonly string[]): { file: string; start: number } | undefined {
  const allowed = new Set(files), sources = new Map<string, ts.SourceFile>();
  const source = (file: string) => {
    if (!sources.has(file)) sources.set(file, ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
    return sources.get(file)!;
  };
  const importedFile = (file: string, specifier: ts.Expression): string | undefined => {
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) return;
    const resolved = ts.resolveModuleName(specifier.text, file, { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true }, ts.sys).resolvedModule;
    if (!resolved) return;
    const target = realpathSync(resolved.resolvedFileName);
    return allowed.has(target) ? target : undefined;
  };
  type Expression = { file: string; node: ts.Expression };
  const resolveExpression = (file: string, node: ts.Expression, seen: Set<ts.Node | string>): Expression | undefined => {
    if (seen.has(node)) return;
    seen = new Set([...seen, node]);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) return resolveExpression(file, node.expression, seen);
    if (ts.isIdentifier(node)) {
      for (const statement of source(file).statements) {
        if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
          const binding = statement.declarationList.declarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === node.text);
          if (binding?.initializer) return resolveExpression(file, binding.initializer, seen);
        }
        if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
        const bindings = statement.importClause.namedBindings;
        const binding = bindings && ts.isNamedImports(bindings) ? bindings.elements.find(binding => !binding.isTypeOnly && binding.name.text === node.text) : undefined;
        const name = statement.importClause.name?.text === node.text ? "default" : binding ? binding.propertyName?.text ?? binding.name.text : undefined;
        const target = name && importedFile(file, statement.moduleSpecifier);
        if (target) return resolveExport(target, name!, seen);
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      for (const statement of source(file).statements) {
        if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamespaceImport(bindings) || bindings.name.text !== node.expression.text) continue;
        const target = importedFile(file, statement.moduleSpecifier);
        if (target) return resolveExport(target, node.name.text, seen);
      }
    }
    return { file, node };
  };
  const resolveExport = (file: string, name: string, seen: Set<ts.Node | string>): Expression | undefined => {
    const identity = `${file}:${name}`;
    if (seen.has(identity)) return;
    seen = new Set([...seen, identity]);
    const stars: string[] = [];
    for (const statement of source(file).statements) {
      if (name === "default" && ts.isExportAssignment(statement) && !statement.isExportEquals) return resolveExpression(file, statement.expression, seen);
      if (ts.isVariableStatement(statement) && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        const binding = statement.declarationList.declarations.find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name);
        if (binding?.initializer) return resolveExpression(file, binding.initializer, seen);
      }
      if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
      const target = statement.moduleSpecifier && importedFile(file, statement.moduleSpecifier);
      if (!statement.exportClause) { if (target && name !== "default") stars.push(target); continue; }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      const binding = statement.exportClause.elements.find(binding => !binding.isTypeOnly && binding.name.text === name);
      if (!binding) continue;
      const local = binding.propertyName ?? binding.name;
      return target ? resolveExport(target, local.text, seen) : resolveExpression(file, local, seen);
    }
    for (const target of stars) {
      const value = resolveExport(target, name, seen);
      if (value) return value;
    }
    return;
  };
  const isBot = ({ file, node }: Expression): boolean => {
    if (!ts.isCallExpression(node)) return false;
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "steamharness" && callee.name.text === "defineBot") return true;
    for (const statement of source(file).statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !["steamharness", "steamharness/agent"].includes(statement.moduleSpecifier.text) || statement.importClause?.isTypeOnly) continue;
      const clause = statement.importClause, bindings = clause?.namedBindings;
      if (ts.isIdentifier(callee) && bindings && ts.isNamedImports(bindings) && bindings.elements.some(binding => !binding.isTypeOnly && binding.name.text === callee.text && (binding.propertyName?.text ?? binding.name.text) === "defineBot")) return true;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.name.text === "defineBot" &&
        (clause?.name?.text === callee.expression.text || bindings && ts.isNamespaceImport(bindings) && bindings.name.text === callee.expression.text)) return true;
    }
    return false;
  };
  const entry = realpathSync(entryFile);
  for (const name of ["executor", "default"]) {
    const value = resolveExport(entry, name, new Set());
    if (value && isBot(value)) return { file: value.file, start: value.node.getStart(source(value.file)) };
  }
  return;
}
