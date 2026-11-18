import { readFile } from "node:fs/promises";
import path from "node:path";
import { inferServerEnvMode } from "./env";
import { resolveServerPathRoots } from "./paths";
import { resolveReleaseMetadataRootFromEnv } from "./release-paths";
import type { ServerBuildInfo } from "./build-info";
import type { SupportedLocale } from "@steamharness/i18n";
import { publicServiceUrls } from "@steamharness/service-urls";
import { checkoutServiceChannel } from "@steamharness/service-urls/node";
import type { Express } from "express";

export interface ServerHealthRelease {
  unit: "server" | "server-web";
  tag: string | null;
  version: string | null;
  versionLabel: string | null;
  publishedAt: string | null;
  commitSha: string | null;
  components: Record<string, string>;
  /** @deprecated Release notes are linked, not embedded. */
  releaseNotes: null;
  deploymentId?: string;
  docsPath?: string;
  docsUrl?: string;
  source: "release-metadata" | "package-manifest";
}

export interface ServerHealthData {
  status: "ok";
  runtime: {
    mode: "development" | "production";
    startedAt: string;
  };
  versions: {
    serverVersion: string | null;
    coreVersion: string | null;
  };
  currentRelease: {
    summary: string;
    docsUrl: string;
  } | null;
  deployment: {
    server: ServerHealthRelease | null;
    serverWeb: ServerHealthRelease | null;
  };
}

export async function createProjectServerHealthData(options: {
  mode?: "development" | "production";
  startedAt?: string;
  serverRoot?: string;
  metadataRoot?: string;
  docsBaseUrl?: string;
  buildInfo?: ServerBuildInfo;
  locale?: SupportedLocale;
  channel?: "stable" | "alpha";
} = {}): Promise<ServerHealthData> {
  const { serverRoot } = resolveServerPathRoots();
  const locale = options.locale ?? "en";
  const resolvedServerRoot = options.serverRoot?.trim()
    ? path.resolve(options.serverRoot.trim())
    : serverRoot;
  const serviceChannel = checkoutServiceChannel({
    root: resolvedServerRoot,
    env: options.channel ? { ...process.env, STEAMHARNESS_SERVICE_CHANNEL: options.channel } : process.env,
    fallback: (options.mode ?? inferServerEnvMode()) === "development" ? "dev" : "main",
  });
  const channel = options.channel ?? (serviceChannel === "alpha" ? "alpha" : "stable");
  const metadataRoot = options.metadataRoot?.trim()
    ? path.resolve(options.metadataRoot.trim())
    : resolveReleaseMetadataRootFromEnv();
  const [serverRelease, serverWebRelease] = await Promise.all([
    resolveDeploymentRelease({
      unit: "server",
      serverRoot: resolvedServerRoot,
      metadataRoot,
      packageJsonFile: path.join(resolvedServerRoot, "package.json"),
      locale,
      channel,
    }),
    resolveDeploymentRelease({
      unit: "server-web",
      serverRoot: resolvedServerRoot,
      metadataRoot,
      packageJsonFile: path.join(resolvedServerRoot, "web", "package.json"),
      locale,
      channel,
    }),
  ]);
  const serverVersion = options.buildInfo?.productVersion ?? serverRelease?.version ?? null;
  const coreVersion = options.buildInfo?.coreVersion ?? serverRelease?.components.core
    ?? readOptionalString((await readJsonIfExists(path.join(resolvedServerRoot, "node_modules", "steamharness", "package.json")))?.version);
  const docsBaseUrl = docsOrigin(options.docsBaseUrl, serviceChannel);
  const server = attachReleaseLink(serverRelease, docsBaseUrl, locale, serverVersion);
  const serverWeb = attachReleaseLink(serverWebRelease, docsBaseUrl, locale);

  return {
    status: "ok",
    runtime: {
      mode: options.mode ?? inferServerEnvMode(),
      startedAt: options.startedAt ?? new Date().toISOString(),
    },
    versions: {
      serverVersion,
      coreVersion,
    },
    currentRelease: serverVersion && server?.docsUrl
      ? {
          // Older Server Web clients require a nonempty summary to show the link.
          summary: locale === "en" ? `View Server v${serverVersion} release notes` : `查看 Server v${serverVersion} 更新日志`,
          docsUrl: server.docsUrl,
        }
      : null,
    deployment: {
      server,
      serverWeb,
    },
  };
}

function docsOrigin(override?: string, channel = checkoutServiceChannel({ fallback: "main" })) {
  return (override ?? process.env.STEAMHARNESS_DOCS_PUBLIC_BASE_URL ?? publicServiceUrls(channel).docs).replace(/\/$/u, "");
}

export function registerLegacyReleaseNoteRoutes(app: Express, options: () => Parameters<typeof createProjectServerHealthData>[0]) {
  app.get(/^\/(deployment-notes|server-web-notes)(?:\.(zh-CN|en))?\.md$/u, async (req, res, next) => {
    try {
      const locale = req.params[1] === "en" ? "en" : "zh-CN";
      const config = options();
      const health = await createProjectServerHealthData({ ...config, locale });
      const web = req.params[0] === "server-web-notes";
      const release = web ? health.deployment.serverWeb : health.deployment.server;
      const unit = web ? "server-web" : "server";
      const index = `${locale === "en" ? "/en" : ""}/guides/releases/${unit}/`;
      const base = docsOrigin(config?.docsBaseUrl, config?.channel === "alpha" ? "alpha" : undefined);
      const version = req.query.version;
      const activeVersion = web ? release?.version : health.versions.serverVersion;
      const target = typeof version !== "string" || !isReleaseVersion(version)
        ? `${base}${index}`
        : version === activeVersion && release?.docsUrl ? release.docsUrl : `${base}${index}v${version}/`;
      res.set("Cache-Control", "no-store").redirect(302, target);
    } catch (error) {
      next(error);
    }
  });
}

async function resolveDeploymentRelease(options: {
  unit: "server" | "server-web";
  serverRoot: string;
  metadataRoot?: string;
  packageJsonFile: string;
  locale: SupportedLocale;
  channel: "stable" | "alpha";
}): Promise<ServerHealthRelease | null> {
  const metadata = options.metadataRoot
    ? await readJsonIfExists(path.join(options.metadataRoot, options.unit, options.channel, "release.json"))
    : null;

  if (metadata) {
    return normalizeHealthRelease({
      unit: options.unit,
      tag: readOptionalString(metadata.tag) ?? `${options.unit}/v${readOptionalString(metadata.version) ?? ""}`,
      version: readOptionalString(metadata.version),
      publishedAt: readOptionalString(metadata.publishedAt),
      commitSha: readOptionalString(metadata.commitSha),
      components: readStringRecord(metadata.components),
      ...(readOptionalString(metadata.deploymentId) ? { deploymentId: readOptionalString(metadata.deploymentId)! } : {}),
      ...(readDocsPath(metadata.docsPaths, options.locale) ? { docsPath: readDocsPath(metadata.docsPaths, options.locale)! } : {}),
      source: "release-metadata",
    });
  }

  const packageJson = await readJsonIfExists(options.packageJsonFile);
  const version = readOptionalString(packageJson?.version);

  if (!version) {
    return null;
  }

  return normalizeHealthRelease({
    unit: options.unit,
    tag: `${options.channel === "alpha" ? "alpha" : options.unit}/v${version}`,
    version,
    publishedAt: null,
    commitSha: null,
    components: {},
    source: "package-manifest",
  });
}

function normalizeHealthRelease(input: {
  unit: "server" | "server-web";
  tag: string | null;
  version: string | null;
  publishedAt: string | null;
  commitSha: string | null;
  components: Record<string, string>;
  deploymentId?: string;
  docsPath?: string;
  source: "release-metadata" | "package-manifest";
}): ServerHealthRelease | null {
  if (!input.version) {
    return null;
  }

  return {
    unit: input.unit,
    tag: input.tag,
    version: input.version,
    versionLabel: `v${input.version}`,
    publishedAt: input.publishedAt,
    commitSha: input.commitSha,
    components: input.components,
    releaseNotes: null,
    ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}),
    ...(input.docsPath ? { docsPath: input.docsPath } : {}),
    source: input.source,
  };
}

async function readJsonIfExists(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
  ));
}

function isReleaseVersion(value: string) {
  return /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)?$/u.test(value);
}

function attachReleaseLink(release: ServerHealthRelease | null, base: string, locale: SupportedLocale, version = release?.version) {
  if (!release || !version || !isReleaseVersion(version)) return release;
  const prefix = locale === "en" ? "/en" : "";
  const suffix = `/${release.unit}/v${version}`;
  const paths = [`${prefix}/guides/releases${suffix}/`, `${prefix}/enhanced/releases${suffix}/`];
  // Old metadata may point at a rolling Markdown filename. Derive an exact version link instead.
  const candidate = release.version === version ? release.docsPath?.replace(/\/?$/u, "/") : undefined;
  const docsPath = candidate && paths.includes(candidate) ? candidate : paths[0];
  return { ...release, docsPath, docsUrl: `${base}${docsPath}` };
}

function readDocsPath(value: unknown, locale: SupportedLocale): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = readOptionalString((value as Record<string, unknown>)[locale]);
  return candidate && /^\/[a-zA-Z0-9/_.-]+$/.test(candidate) && !candidate.includes("..") && !candidate.startsWith("//") ? candidate : null;
}
