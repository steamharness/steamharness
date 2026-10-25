import { execFileSync } from "node:child_process";
import { resolveServiceChannel } from "./index.ts";

/** Resolve at build/launch time. Published clients must embed the result. */
export function checkoutServiceChannel({ root, env = process.env, mode, fallback = "dev" } = {}) {
  const channel = env.STEAMHARNESS_SERVICE_CHANNEL || env.STEAMHARNESS_DEPLOYMENT_CHANNEL || env.STEAMHARNESS_RELEASE_CHANNEL;
  let branch = env.CI_COMMIT_BRANCH || env.CI_COMMIT_REF_NAME || env.GITHUB_REF;
  if (!channel && !["dev", "alpha", "main"].includes(mode) && !branch && root) {
    try {
      branch = execFileSync("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000,
      }).trim();
    } catch { /* Archives and detached builds require an explicit channel. */ }
  }
  return resolveServiceChannel({ channel, branch, mode, fallback });
}
