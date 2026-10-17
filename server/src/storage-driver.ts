/**
 * Local object-storage configuration.
 *
 * Everything here is a pure env resolver so the configuration can be tested
 * without touching `process.env`. The Server stores objects on its own disk
 * under the data root, so a checkout runs with no object-storage credentials at
 * all; an operator who needs remote object storage configures it in the private
 * deployment rather than in this repository.
 */
import path from "node:path";
import { DEFAULT_DEV_SERVER_PORT } from "./dev-port";
import { inferServerEnvMode } from "./env";
import type { WorkflowStorageDriver } from "./object-storage";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * Public base URLs a deployment can set, most specific first. The storage-specific
 * one is last because it means "the Server's own origin" rather than a CDN origin,
 * so an operator's API origin is the better hint.
 */
const LOCAL_PUBLIC_BASE_URL_KEYS = [
  "STEAMHARNESS_API_PUBLIC_BASE_URL",
  "STEAMHARNESS_PUBLIC_BASE_URL",
  "STEAMHARNESS_STORAGE_PUBLIC_BASE_URL",
] as const;

/**
 * The Server always stores objects on local disk. The driver name is still read so
 * an inherited value of `oss` fails loudly at startup rather than being ignored:
 * silently serving from a different backend than the environment claims is the
 * failure mode worth the extra error.
 */
export function resolveWorkflowStorageDriver(
  env: NodeJS.ProcessEnv = process.env,
): WorkflowStorageDriver {
  const raw = env.STEAMHARNESS_STORAGE_DRIVER?.trim().toLowerCase();
  if (!raw || raw === "local") {
    return "local";
  }
  throw new Error('STEAMHARNESS_STORAGE_DRIVER must be "local".');
}

/**
 * Validate a public base URL. Objects are served by the Server itself, so a
 * loopback or private address may use plain HTTP while anything else must be HTTPS.
 */
export function normalizeStorageBaseUrl(
  value: string,
  options: { envName: string },
): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
  ) {
    throw new Error(`${options.envName} must be an HTTP(S) root URL.`);
  }
  return url.toString();
}

/**
 * Root directory for object storage. Defaults under the Server data root so it
 * follows the same persistence/backup story as run files and project sources.
 */
export function resolveLocalStorageRootFromEnv(options: {
  env?: NodeJS.ProcessEnv;
  dataRoot: string;
}): string {
  const env = options.env ?? process.env;
  const explicit = env.STEAMHARNESS_LOCAL_STORAGE_ROOT?.trim();
  if (!explicit) {
    return path.join(options.dataRoot, "object-storage");
  }
  if (!path.isAbsolute(explicit)) {
    throw new Error("STEAMHARNESS_LOCAL_STORAGE_ROOT must be an absolute path.");
  }
  return path.resolve(explicit);
}

/**
 * Origin that object URLs are minted from, so avatars render in a browser or the
 * Desktop App.
 *
 * Development falls back to loopback with a warning because a dev server is
 * reached from the same machine; anything else fails at startup rather than
 * handing users an unreachable URL.
 */
export function resolveLocalStoragePublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of LOCAL_PUBLIC_BASE_URL_KEYS) {
    const value = env[name]?.trim();
    if (value) {
      return normalizeStorageBaseUrl(value, { envName: name });
    }
  }

  if (inferServerEnvMode(env) !== "development") {
    throw new Error(
      "STEAMHARNESS_API_PUBLIC_BASE_URL is required: "
      + "avatar URLs are minted from the Server's public origin.",
    );
  }

  const port = env.STEAMHARNESS_SERVER_PORT?.trim() || env.PORT?.trim() || String(DEFAULT_DEV_SERVER_PORT);
  console.warn(
    `[workflow-server] STEAMHARNESS_API_PUBLIC_BASE_URL is not set; local object storage will mint `
    + `http://${LOOPBACK_HOST}:${port} URLs. Browsers and the Desktop App on other machines `
    + "will not be able to load these assets.",
  );
  return `http://${LOOPBACK_HOST}:${port}/`;
}

/**
 * Origin accepted for stored avatar URLs: the Server's own public origin.
 */
export function resolveStorageAvatarBaseUrlOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return new URL(resolveLocalStoragePublicBaseUrl(env)).origin;
}
