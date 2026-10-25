import type { ServiceChannel } from "./index";

export function checkoutServiceChannel(options?: {
  root?: string;
  env?: Record<string, string | undefined>;
  mode?: string;
  fallback?: ServiceChannel;
}): ServiceChannel;
