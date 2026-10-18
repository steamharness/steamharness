import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateDocs } from "./validate-docs.mjs";

const DEFAULT_API_BASE_URL = "https://api.steamharness.yuhe.space";

export async function buildDocs(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const siteDir = path.resolve(options.siteDir ?? path.join(root, "build"));
  const outputDir = path.resolve(options.outputDir ?? path.join(root, "dist", "site"));
  if (outputDir === root || !outputDir.startsWith(`${root}${path.sep}`)) {
    throw new Error("Docs build output must be a child directory of the repository root.");
  }
  if (siteDir === outputDir || outputDir.startsWith(`${siteDir}${path.sep}`)) {
    throw new Error("Docs build output must not be inside the Docusaurus build directory.");
  }

  const validation = await validateDocs({ root });
  await assertDocusaurusSite(siteDir);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(path.dirname(outputDir), { recursive: true });
  await cp(siteDir, outputDir, { recursive: true });

  const runtimeDir = path.join(outputDir, ".workflow");
  await mkdir(runtimeDir, { recursive: true });
  await Promise.all([
    cp(path.join(root, "scripts", "activate-docs.mjs"), path.join(runtimeDir, "activate-docs.mjs")),
    cp(path.join(root, "scripts", "serve-docs.mjs"), path.join(runtimeDir, "serve-docs.mjs")),
  ]);

  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? process.env.STEAMHARNESS_DOCS_API_PUBLIC_BASE_URL);
  const commitSha = String(options.commitSha ?? process.env.CI_COMMIT_SHA ?? "").trim() || null;
  await writeFile(path.join(outputDir, "deployment.json"), `${JSON.stringify({
    schemaVersion: 1,
    framework: "docusaurus",
    commitSha,
    builtAt: options.builtAt ?? process.env.CI_COMMIT_TIMESTAMP ?? null,
    apiBaseUrl,
  }, null, 2)}\n`, "utf8");
  return { outputDir, siteDir, apiBaseUrl, validation };
}

async function assertDocusaurusSite(siteDir) {
  for (const relativePath of ["index.html", path.join("en", "index.html"), "404.html"]) {
    const filePath = path.join(siteDir, relativePath);
    const info = await stat(filePath).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`Docusaurus build is missing ${relativePath}.`);
  }
  const index = await readFile(path.join(siteDir, "index.html"), "utf8");
  if (!index.includes('name="generator" content="Docusaurus')) {
    throw new Error("Docs build does not contain a Docusaurus-generated index.");
  }
}

export function rewriteOpenApiServers(source, apiBaseUrl) {
  const resolved = normalizeApiBaseUrl(apiBaseUrl);
  const block = [
    "servers:",
    `  - url: ${resolved}`,
    "    description: Public Workflow API (release default)",
  ].join("\n");
  const pattern = /^servers:\r?\n(?:  - .*\r?\n(?:    .*\r?\n)*)+/m;
  if (!pattern.test(source)) throw new Error("OpenAPI source does not contain a top-level servers block.");
  return source.replace(pattern, `${block}\n`);
}

export function normalizeApiBaseUrl(value) {
  const raw = String(value ?? "").trim() || DEFAULT_API_BASE_URL;
  const parsed = new URL(raw);
  if (!/^https?:$/u.test(parsed.protocol)) throw new Error("Docs API base URL must use HTTP or HTTPS.");
  parsed.search = "";
  parsed.hash = "";
  if (parsed.pathname === "/api" || parsed.pathname === "/api/") parsed.pathname = "/";
  return parsed.toString().replace(/\/$/u, "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await buildDocs();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
