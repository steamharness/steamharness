import { pathToFileURL } from "node:url";
import path from "node:path";

export const REQUIRED_PRODUCTION_ENV = Object.freeze([
  "WORKFLOW_SERVER_ADMIN_KEY",
  "WORKFLOW_AUTH_COOKIE_SECRET",
  "WORKFLOW_BOOTSTRAP_ADMIN_EMAIL",
  "WORKFLOW_BOOTSTRAP_ADMIN_PASSWORD",
  "WORKFLOW_DATABASE_URL",
  "WORKFLOW_POSTGRES_PASSWORD",
  "WORKFLOW_RELEASE_STORAGE_ROOT",
]);

export function findMissingProductionEnv(env = process.env) {
  return REQUIRED_PRODUCTION_ENV.filter((name) => String(env[name] ?? "").trim() === "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const missing = findMissingProductionEnv();
  if (missing.length > 0) {
    console.error(`Missing protected production CI/CD variables: ${missing.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("Production CI/CD variable names are configured.");
  }
}
