import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeApiBaseUrl, rewriteOpenApiServers } from "./build-docs.mjs";

export async function prepareOpenApiSpecs(options = {}) {
  const root = path.resolve(options.root ?? path.resolve(import.meta.dirname, ".."));
  const outputDir = path.resolve(options.outputDir ?? path.join(root, ".docusaurus-openapi"));
  if (outputDir === root || !outputDir.startsWith(`${root}${path.sep}`)) {
    throw new Error("Docusaurus OpenAPI output must be a child directory of the repository root.");
  }
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl ?? process.env.WORKFLOW_DOCS_API_PUBLIC_BASE_URL);
  const specs = [
    [path.join(root, "openapi", "workflow-code.openapi.yaml"), path.join(outputDir, "workflow-code.zh.yaml")],
    [path.join(root, "en", "openapi", "workflow-code.openapi.yaml"), path.join(outputDir, "workflow-code.en.yaml")],
  ];

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  for (const [sourcePath, outputPath] of specs) {
    const source = await readFile(sourcePath, "utf8");
    await writeFile(outputPath, rewriteOpenApiServers(source, apiBaseUrl), "utf8");
  }
  return { outputDir, apiBaseUrl };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await prepareOpenApiSpecs();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
