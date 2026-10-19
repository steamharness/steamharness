#!/usr/bin/env node

import { createReadStream, realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

export async function createDocsServer(options = {}) {
  const root = path.resolve(String(options.root ?? ""));
  const deployment = JSON.parse(await readFile(path.join(root, "deployment.json"), "utf8"));
  if (deployment.framework !== "docusaurus") {
    throw new Error("Docs static server requires a Docusaurus deployment.");
  }
  const host = String(options.host ?? "0.0.0.0");
  const port = normalizePort(options.port ?? 7132);
  const server = http.createServer((request, response) => {
    handleRequest({ request, response, root, deployment }).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Internal Server Error");
      process.stderr.write(`${error.stack ?? error}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

async function handleRequest({ request, response, root, deployment }) {
  if (!new Set(["GET", "HEAD"]).has(request.method ?? "GET")) {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    await sendNotFound({ request, response, root, deployment });
    return;
  }
  if (pathname.split("/").includes(".workflow") || pathname.includes("\0")) {
    await sendNotFound({ request, response, root, deployment });
    return;
  }

  const file = await resolveRequestFile(root, pathname);
  if (!file) {
    await sendNotFound({ request, response, root, deployment });
    return;
  }
  await sendFile({ request, response, file, deployment, statusCode: 200 });
}

export async function resolveRequestFile(root, pathname) {
  const absoluteRoot = path.resolve(root);
  const requested = path.resolve(absoluteRoot, pathname.replace(/^\/+/, ""));
  if (requested !== absoluteRoot && !requested.startsWith(`${absoluteRoot}${path.sep}`)) return undefined;
  for (const candidate of [requested, path.join(requested, "index.html"), `${requested}.html`]) {
    const info = await stat(candidate).catch(() => undefined);
    if (info?.isFile()) return { path: candidate, size: info.size };
  }
  return undefined;
}

async function sendNotFound({ request, response, root, deployment }) {
  const fallback = await resolveRequestFile(root, "/404.html");
  if (fallback) {
    await sendFile({ request, response, file: fallback, deployment, statusCode: 404 });
    return;
  }
  writeHeaders(response, deployment, 404, "text/plain; charset=utf-8", 14, false);
  if (request.method === "HEAD") response.end();
  else response.end("404 Not Found\n");
}

async function sendFile({ request, response, file, deployment, statusCode }) {
  const type = MIME_TYPES.get(path.extname(file.path).toLowerCase()) ?? "application/octet-stream";
  const immutable = file.path.includes(`${path.sep}assets${path.sep}`);
  writeHeaders(response, deployment, statusCode, type, file.size, immutable);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file.path);
    stream.once("error", reject);
    stream.once("end", resolve);
    stream.pipe(response);
  });
}

function writeHeaders(response, deployment, statusCode, type, size, immutable) {
  response.writeHead(statusCode, {
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
    "Content-Length": String(size),
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "X-SteamHarness-Docs-Commit": String(deployment.commitSha ?? "local"),
    "X-SteamHarness-Docs-Framework": "docusaurus",
  });
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Docs port must be valid.");
  return port;
}

function readArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const root = readArgument("--root", process.cwd());
  const host = readArgument("--host", "0.0.0.0");
  const port = readArgument("--port", process.env.PORT ?? 7132);
  const server = await createDocsServer({ root, host, port });
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ framework: "docusaurus", root: path.resolve(root), address })}\n`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
