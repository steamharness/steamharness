import { fileURLToPath } from "node:url";
import { publicServiceUrls, type ServiceChannel } from "@steamharness/service-urls";
import { checkoutServiceChannel } from "@steamharness/service-urls/node";

declare const __STEAMHARNESS_SERVICE_CHANNEL__: ServiceChannel;
const buildChannel = typeof __STEAMHARNESS_SERVICE_CHANNEL__ !== "undefined"
  ? __STEAMHARNESS_SERVICE_CHANNEL__
  : checkoutServiceChannel({ root: fileURLToPath(new URL("..", import.meta.url)) });

/** Published clients keep their build channel regardless of the user's project branch. */
export function defaultServerUrl(env: Record<string, string | undefined> = process.env): string {
  return publicServiceUrls(checkoutServiceChannel({ env: {
    STEAMHARNESS_SERVICE_CHANNEL: env.STEAMHARNESS_SERVICE_CHANNEL,
    STEAMHARNESS_DEPLOYMENT_CHANNEL: env.STEAMHARNESS_DEPLOYMENT_CHANNEL,
    STEAMHARNESS_RELEASE_CHANNEL: env.STEAMHARNESS_RELEASE_CHANNEL,
  }, fallback: buildChannel })).server;
}
