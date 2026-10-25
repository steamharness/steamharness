import { readFile } from "node:fs/promises";
import path from "node:path";
import { inferServerEnvMode } from "./env";
import { resolveServerPathRoots } from "./paths";
import { resolveReleaseMetadataRootFromEnv } from "./release-paths";
import type { ServerBuildInfo } from "./build-info";
import type { SupportedLocale } from "@steamharness/i18n";
import { publicServiceUrls } from "@steamharness/service-urls";
import { checkoutServiceChannel } from "@steamharness/service-urls/node";

export interface ServerHealthRelease {
  unit: "server" | "server-web";
  tag: string | null;
  version: string | null;
  versionLabel: string | null;
  publishedAt: string | null;
  commitSha: string | null;
  components: Record<string, string>;
  releaseNotes: { format: "markdown"; body: string } | null;
  deploymentId?: string;
  docsPath?: string;
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
    body: string;
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
  const docsBaseUrl = (options.docsBaseUrl ?? process.env.STEAMHARNESS_DOCS_PUBLIC_BASE_URL ?? publicServiceUrls(serviceChannel).docs)
    .replace(/\/$/, "");
  const serverReleaseBody = serverRelease !== null && serverRelease.version === serverVersion
    ? serverRelease.releaseNotes?.body.trim() ?? ""
    : "";

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
    currentRelease: serverVersion && serverReleaseBody
      ? {
          summary: summarizeMarkdown(serverReleaseBody),
          body: serverReleaseBody,
          // Server announcements link to the dedicated generated
          // page for this exact version.
          docsUrl: serverRelease?.docsPath ? `${docsBaseUrl}${serverRelease.docsPath}` : `${docsBaseUrl}${locale === "en" ? "/en" : ""}/guides/releases/server/v${serverVersion}`,
        }
      : null,
    deployment: {
      server: serverRelease,
      serverWeb: serverWebRelease,
    },
  };
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
      releaseNotes: readReleaseNotes(metadata.releaseNotes, options.locale),
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
    releaseNotes: null,
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
  releaseNotes: { format: "markdown"; body: string } | null;
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
    releaseNotes: input.releaseNotes,
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

function readReleaseNotes(value: unknown, locale: SupportedLocale): { format: "markdown"; body: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const localizations = isRecord(record.localizations) ? record.localizations : null;
  const localized = localizations && isRecord(localizations[locale])
    ? localizations[locale]
    : null;
  if (localized?.format === "markdown" && typeof localized.body === "string") {
    return { format: "markdown", body: localized.body };
  }
  return record.format === "markdown" && typeof record.body === "string"
    ? { format: "markdown", body: record.body }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeMarkdown(body: string): string {
  const line = body.split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item !== "" && !item.startsWith("#"));
  const summary = (line ?? body)
    .replace(/^[-*]\s+/, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .trim();
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}

function readDocsPath(value: unknown, locale: SupportedLocale): string | null {
  if (!isRecord(value)) return null;
  const candidate = readOptionalString(value[locale]);
  return candidate && /^\/[a-zA-Z0-9/_.-]+$/.test(candidate) && !candidate.includes("..") && !candidate.startsWith("//") ? candidate : null;
}
