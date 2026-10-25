export type ServiceChannel = "dev" | "alpha" | "main";

export function normalizeServiceChannel(value?: string): ServiceChannel | undefined {
  const channel = value?.trim();
  if (channel === "stable") return "main";
  return channel === "dev" || channel === "alpha" || channel === "main" ? channel : undefined;
}

/** Build mode "production" controls optimization; it does not select a service. */
export function resolveServiceChannel(options: {
  channel?: string;
  mode?: string;
  branch?: string;
  fallback?: ServiceChannel;
} = {}): ServiceChannel {
  if (options.channel?.trim()) {
    const channel = normalizeServiceChannel(options.channel);
    if (!channel) throw new Error("Service channel must be dev, alpha or main.");
    return channel;
  }
  const mode = normalizeServiceChannel(options.mode);
  if (mode) return mode;
  if (options.branch) {
    const branch = options.branch.replace(/^refs\/(?:heads|remotes\/origin)\//u, "");
    return normalizeServiceChannel(branch) ?? (branch.startsWith("refs/tags/alpha/") ? "alpha"
      : branch.startsWith("refs/tags/") ? "main" : "dev");
  }
  return options.fallback ?? "dev";
}

export function publicServiceUrls(channel: ServiceChannel): { server: string; docs: string } {
  if (channel === "dev") return { server: "http://localhost:7126", docs: "http://localhost:7135" };
  const suffix = channel === "alpha" ? "-alpha" : "";
  return {
    server: `https://server${suffix}.steamharness.yuhe.space`,
    docs: `https://docs${suffix}.steamharness.yuhe.space`,
  };
}

/** Infer links next to an explicitly selected Server without changing that selection. */
export function serviceChannelFromServerUrl(value?: string): ServiceChannel | undefined {
  try {
    const url = new URL(value ?? "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return "dev";
    if (["server-alpha", "alpha", "alpha-web"].some(host => url.hostname === `${host}.steamharness.yuhe.space`)) return "alpha";
    if (["server", "api", "www"].some(host => url.hostname === `${host}.steamharness.yuhe.space`)
      || url.hostname === "steamharness.yuhe.space") return "main";
    return undefined;
  } catch {
    return undefined;
  }
}
