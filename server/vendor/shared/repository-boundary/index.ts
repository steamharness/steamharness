import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([
  ".git", ".pnpm-store", ".release", ".steamharness-local", "coverage", "dist", "node_modules", "out", "public", "release", "vendor",
]);

export interface RepositoryBoundaryViolation {
  file: string;
  kind:
    | "cross-repository-import"
    | "cross-repository-config-reference"
    | "cross-repository-path-alias"
    | "main-local-source-link"
    | "relative-package-dependency"
    | "tracked-development-adapter";
  detail: string;
}

export async function scanRepositoryBoundaries(root: string): Promise<RepositoryBoundaryViolation[]> {
  const absoluteRoot = path.resolve(root);
  const files = await listFiles(absoluteRoot);
  const violations = (await Promise.all(files.map(async (relativePath) => {
    const absolutePath = path.join(absoluteRoot, relativePath);
    if (path.basename(relativePath) === "package.json") {
      return scanPackageJson(absoluteRoot, relativePath, await readFile(absolutePath, "utf8"));
    }
    if (/^(?:tsconfig|jsconfig).*\.json$/i.test(path.basename(relativePath))) {
      return scanTypeScriptConfig(absoluteRoot, relativePath, await readFile(absolutePath, "utf8"));
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(relativePath))) return [];
    return scanSourceImports(absoluteRoot, relativePath, await readFile(absolutePath, "utf8"));
  }))).flat();
  for (const trackedPath of listTrackedDevelopmentAdapters(absoluteRoot)) {
    violations.push({
      file: trackedPath,
      kind: "tracked-development-adapter",
      detail: "generated local-source configuration must stay untracked",
    });
  }
  return violations.sort((left, right) => left.file.localeCompare(right.file) || left.detail.localeCompare(right.detail));
}

export async function scanPreparedRepositoryMode(
  root: string,
  mode: "dev" | "main",
): Promise<RepositoryBoundaryViolation[]> {
  if (mode !== "main") return [];
  const absoluteRoot = path.resolve(root);
  const links = [
    ...await listSymbolicLinks(path.join(absoluteRoot, ".shared"), ".shared"),
    ...await listSymbolicLinks(path.join(absoluteRoot, "vendor", "shared"), "vendor/shared"),
  ];
  return links.map((file) => ({
    file,
    kind: "main-local-source-link",
    detail: "main and tag builds must contain ordinary vendor/shared files without source links",
  }));
}

export function assertRepositoryBoundaries(violations: readonly RepositoryBoundaryViolation[]): void {
  if (violations.length === 0) return;
  throw new Error([
    "Repository boundary violations:",
    ...violations.map((violation) => `- ${violation.file}: ${violation.kind}: ${violation.detail}`),
  ].join("\n"));
}

function scanSourceImports(root: string, relativePath: string, source: string): RepositoryBoundaryViolation[] {
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind(relativePath));
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return specifiers.flatMap((specifier): RepositoryBoundaryViolation[] => {
    if (!specifier.startsWith(".")) return [];
    const resolved = path.resolve(root, path.dirname(relativePath), specifier);
    return isInside(root, resolved) ? [] : [{
      file: normalize(relativePath),
      kind: "cross-repository-import",
      detail: specifier,
    }];
  });
}

function scanPackageJson(root: string, relativePath: string, source: string): RepositoryBoundaryViolation[] {
  const manifest = JSON.parse(source) as Record<string, unknown>;
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  return sections.flatMap((section): RepositoryBoundaryViolation[] => {
    const dependencies = manifest[section];
    if (!isRecord(dependencies)) return [];
    return Object.entries(dependencies).flatMap(([name, value]) => {
      if (typeof value !== "string" || !/^(?:file|link):/i.test(value)) return [];
      const target = value.replace(/^(?:file|link):/i, "");
      const resolved = path.resolve(root, path.dirname(relativePath), target);
      return isInside(root, resolved) ? [] : [{
        file: normalize(relativePath),
        kind: "relative-package-dependency",
        detail: `${section}.${name}=${value}`,
      }];
    });
  });
}

function scanTypeScriptConfig(root: string, relativePath: string, source: string): RepositoryBoundaryViolation[] {
  const config = ts.parseConfigFileTextToJson(relativePath, source).config as {
    compilerOptions?: { baseUrl?: unknown; paths?: unknown };
    extends?: unknown;
    references?: unknown;
  } | undefined;
  const violations: RepositoryBoundaryViolation[] = [];
  const configDirectory = path.dirname(path.join(root, relativePath));
  if (typeof config?.extends === "string") {
    const violation = scanConfigReference(root, relativePath, configDirectory, "extends", config.extends);
    if (violation !== undefined) violations.push(violation);
  }
  if (Array.isArray(config?.references)) {
    for (const [index, reference] of config.references.entries()) {
      if (!isRecord(reference) || typeof reference.path !== "string") continue;
      const violation = scanConfigReference(
        root,
        relativePath,
        configDirectory,
        `references[${index}].path`,
        reference.path,
      );
      if (violation !== undefined) violations.push(violation);
    }
  }
  const paths = config?.compilerOptions?.paths;
  if (!isRecord(paths)) return violations;
  const baseUrl = typeof config?.compilerOptions?.baseUrl === "string"
    ? path.resolve(configDirectory, config.compilerOptions.baseUrl)
    : configDirectory;
  violations.push(...Object.entries(paths).flatMap(([alias, values]): RepositoryBoundaryViolation[] => {
    if (!Array.isArray(values)) return [];
    return values.flatMap((value): RepositoryBoundaryViolation[] => {
      if (typeof value !== "string") return [];
      const resolved = path.resolve(baseUrl, value.replace(/\*.*$/, ""));
      return isInside(root, resolved) ? [] : [{
        file: normalize(relativePath),
        kind: "cross-repository-path-alias",
        detail: `${alias}=${value}`,
      }];
    });
  }));
  return violations;
}

function scanConfigReference(
  root: string,
  relativePath: string,
  configDirectory: string,
  field: string,
  value: string,
): RepositoryBoundaryViolation | undefined {
  if (!value.startsWith(".") && !path.isAbsolute(value)) return undefined;
  const resolved = path.resolve(configDirectory, value);
  return isInside(root, resolved) ? undefined : {
    file: normalize(relativePath),
    kind: "cross-repository-config-reference",
    detail: `${field}=${value}`,
  };
}

async function listFiles(root: string, relativeDirectory = ""): Promise<string[]> {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name) && !(relativeDirectory === "" && entry.name === ".shared")) {
        files.push(...await listFiles(root, relativePath));
      }
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

async function listSymbolicLinks(directory: string, displayPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  const links: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const absolutePath = path.join(directory, entry.name);
    const relativePath = normalize(path.join(displayPath, entry.name));
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      links.push(relativePath);
    } else if (stats.isDirectory()) {
      links.push(...await listSymbolicLinks(absolutePath, relativePath));
    }
  }
  return links.sort();
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.js$/i.test(file) || /\.mjs$/i.test(file) || /\.cjs$/i.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function normalize(file: string): string {
  return file.split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function listTrackedDevelopmentAdapters(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z", "--", ".steamharness-local"], {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8").split("\0").filter(Boolean).map(normalize);
  } catch {
    return [];
  }
}
