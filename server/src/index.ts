import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { readFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configureProjectAuthContext, ensureProjectAuthService } from "./auth";
import { AccountRepository } from "./account-db";
import { DEFAULT_DEV_SERVER_PORT, DEFAULT_PRODUCTION_SERVER_PORT, listenServerWithDevPortFallback } from "./dev-port";
import { loadServerEnv } from "./env";
import { createProjectServerHealthData } from "./health";
import { ensureServerI18n, getRequestT, localizeHttpErrorMessage, resolveRequestLocale } from "./i18n";
import { resolveServerPathRoots } from "./paths";
import { fail, toHttpError } from "./protocol";
import { createApiRouter } from "./routes/api";
import { createAdminAliasRouter, createAuthRouter, createMeAliasRouter } from "./routes/auth";
import { createKanbanPreviewAssetRouter } from "./routes/kanban-preview-assets";
import { createProjectCardImageRouter } from "./routes/project-card-images";
import { createRemovedApiRouter } from "./routes/removed-api";
import { createStorageAssetRouter } from "./routes/storage-assets";
import { isProjectLocalStorage } from "./local-storage";
import { createPublicSystemAiUnavailableHandler } from "./public-system-ai";
import { createStorageFromEnv } from "./storage";
import { createWebDevServerOptions } from "./web-dev";

import { AccountMemory } from "./memory";
import { createMemoryRouter } from "./routes/memory";

loadServerEnv();

// i18n must be initialized before any request-localized error is serialized.
ensureServerI18n();

const databaseUrl = process.env.STEAMHARNESS_DATABASE_URL?.trim();
const accountDb = databaseUrl
  ? new AccountRepository(databaseUrl)
  : undefined;
await accountDb?.init();
const storage = await createStorageFromEnv();
const authService = ensureProjectAuthService(accountDb);
const memory = databaseUrl ? new AccountMemory(databaseUrl) : undefined;
await memory?.init();
configureProjectAuthContext({
  memory,
  accountDb,
  authService,
  dataDir: storage.dataRoot,
  objectStorage: storage.objectStorage,
});
const { serverRoot } = resolveServerPathRoots();
const publicRoot = path.join(serverRoot, "public");

const app = express();
const server = createServer(app);
const serverStartedAt = new Date().toISOString();

type ViteModule = {
  createServer: (options: ReturnType<typeof createWebDevServerOptions>) => Promise<ViteDevServer>;
};

type ViteDevServer = {
  middlewares: express.RequestHandler;
  transformIndexHtml: (url: string, html: string) => Promise<string>;
  ssrFixStacktrace: (error: Error) => void;
};

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

// ── Health check (no auth) ───────────────────────────────────────────────────
app.get("/health", (req, res) => {
  // Stage B exposes deployed server/server-web release data here so
  // docs can distinguish the live 7130+ deployment from 712x dev manifests.
  void createProjectServerHealthData({
    startedAt: serverStartedAt,
    buildInfo: storage.getBuildInfo(),
    locale: resolveRequestLocale(req),
  }).then((data) => {
    res.json({ errCode: 0, errMessage: "", data });
  }).catch((error) => {
    console.warn(
      "[steamharness-server] failed to assemble release health metadata.",
      error instanceof Error ? error.message : error,
    );
    res.json({
      errCode: 0,
      errMessage: "",
      data: {
        status: "ok",
        runtime: {
          mode: process.env.STEAMHARNESS_SERVER_DEV === "1" ? "development" : "production",
          startedAt: serverStartedAt,
        },
        versions: {
          serverVersion: null,
          coreVersion: null,
        },
        currentRelease: null,
        deployment: {
          server: null,
          serverWeb: null,
        },
      },
    });
  });
});

app.use(createRemovedApiRouter());

// Project card images are public presentation assets. Upload and metadata
// changes remain protected by the authenticated project routes below.
app.use("/project-card-images", createProjectCardImageRouter(storage));

// Locally stored public objects (avatars) are served straight from disk. Mounted
// here — before the authenticated /api tree and before the Vite/SPA fallback —
// because a later mount would be shadowed by the SPA catch-all.
if (isProjectLocalStorage(storage.objectStorage)) {
  app.use("/storage", createStorageAssetRouter(storage.objectStorage));
}

// ── API auth middleware ──────────────────────────────────────────────────────
// System AI is served by a private gateway. Keep the public contract explicit
// without exposing that service's implementation.
app.use("/api/ai", createPublicSystemAiUnavailableHandler());
app.use("/api/auth", createAuthRouter());
app.use("/api/me", createMemoryRouter(memory));
app.use("/api/me", createMeAliasRouter());
app.use("/api/admin", createAdminAliasRouter());
// Sandboxed Kanban subresources authenticate with their scoped,
// short-lived capability because they cannot inherit the App login session.
app.use("/api", createKanbanPreviewAssetRouter(storage));

// ── API routes ───────────────────────────────────────────────────────────────
// API routes authenticate after matching so removed routes always return 404.
app.use("/api", createApiRouter(storage));

// ── Web admin app: Vite dev middleware in server dev, static build otherwise ─
await mountWebApp({ app, server, serverRoot, publicRoot });

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const httpError = toHttpError(err);
  res.status(httpError.statusCode).json(
    fail(httpError.errCode, localizeHttpErrorMessage(httpError, getRequestT(req)), httpError.data),
  );
});

// ── Start ────────────────────────────────────────────────────────────────────
const defaultPort = process.env.STEAMHARNESS_SERVER_DEV === "1"
  ? DEFAULT_DEV_SERVER_PORT
  : DEFAULT_PRODUCTION_SERVER_PORT;
// PostgreSQL owns 7125; development uses the next loopback port while
// 7130+ remains the release/deploy port band.
const port = readNumberEnv("STEAMHARNESS_SERVER_PORT", Number(process.env.PORT) || defaultPort);

const actualPort = await listenServerWithDevPortFallback(server, {
  port,
  host: process.env.STEAMHARNESS_SERVER_HOST?.trim() || undefined,
  isDev: process.env.STEAMHARNESS_SERVER_DEV === "1",
  strictPort: process.env.STEAMHARNESS_SERVER_STRICT_PORT === "1",
  logger: console,
});
let shutdownPromise: Promise<void> | undefined;
const requestShutdown = (signal: NodeJS.Signals) => {
  if (shutdownPromise !== undefined) return;
  console.log(`[steamharness-server] received ${signal}; shutting down.`);
  const serverStop = closeHttpServer(server);
  const shutdown = (async () => {
    server.closeAllConnections?.();
    await serverStop;
    await storage.close();
    await memory?.close();
    await accountDb?.close();
  })();
  shutdownPromise = shutdown;
  void shutdown.then(
    () => process.exit(process.exitCode ?? 0),
    (error) => {
      console.error("[steamharness-server] graceful shutdown failed.", error);
      process.exit(1);
    },
  );
};
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

console.log(`[steamharness-server] listening on http://localhost:${actualPort}`);
console.log(`[steamharness-server] data root: ${storage.dataRoot}`);

// 管理端支持 env 管理员账号密码登录后，缺少 admin key 不再等于整套管理登录不可用。
if (!process.env.STEAMHARNESS_SERVER_ADMIN_KEY && !process.env.STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL?.trim()) {
  console.warn("[steamharness-server] Neither STEAMHARNESS_SERVER_ADMIN_KEY nor STEAMHARNESS_BOOTSTRAP_ADMIN_EMAIL is set; admin bootstrap login may be unavailable.");
}

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function closeHttpServer(httpServer: HttpServer): Promise<void> {
  if (!httpServer.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function mountWebApp(options: {
  app: Express;
  server: HttpServer;
  serverRoot: string;
  publicRoot: string;
}): Promise<{ mode: "static" | "vite" }> {
  if (shouldUseViteWebDevServer()) {
    try {
      const webRoot = path.join(options.serverRoot, "web");
      const viteModule = await importViteFromWebRoot(webRoot);
      const { createServer: createViteServer } = viteModule;
      const viteOptions = createWebDevServerOptions({ webRoot, server: options.server });
      const vite = await createViteServer(viteOptions);

      options.app.use(vite.middlewares);
      options.app.get("*", async (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }

        try {
          const template = await readFile(path.join(webRoot, "index.html"), "utf8");
          const html = await vite.transformIndexHtml(req.originalUrl, template);
          res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").end(html);
        } catch (error) {
          if (error instanceof Error) {
            vite.ssrFixStacktrace(error);
          }
          next(error);
        }
      });

      const reloadMode = viteOptions.server.hmr === false ? "manual reload" : "HMR";
      console.log(`[steamharness-server] web dev middleware: server/web via Vite ${reloadMode}`);
      return { mode: "vite" };
    } catch (error) {
      console.warn(
        "[steamharness-server] failed to start server/web Vite middleware; falling back to server/public.",
        error instanceof Error ? error.message : error,
      );
    }
  }

  options.app.use(express.static(options.publicRoot));
  options.app.get("*", (req, res, next) => {
    if (req.method !== "GET") {
      next();
      return;
    }

    res.sendFile(path.join(options.publicRoot, "index.html"));
  });
  return { mode: "static" };
}

function shouldUseViteWebDevServer(): boolean {
  return process.env.STEAMHARNESS_SERVER_DEV === "1" && process.env.STEAMHARNESS_SERVER_WEB_DEV !== "0";
}

async function importViteFromWebRoot(webRoot: string): Promise<ViteModule> {
  const requireFromWeb = createRequire(path.join(webRoot, "package.json"));
  let viteEntry: string;

  try {
    viteEntry = requireFromWeb.resolve("vite");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot resolve server/web Vite dependency. Run "pnpm install" from the repository root and retry. ${cause}`,
    );
  }

  return import(pathToFileURL(viteEntry).href) as Promise<ViteModule>;
}
