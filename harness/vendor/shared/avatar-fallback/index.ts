import { toSvg } from "jdenticon/browser";
const avatarCache = new Map<string, string>();

// Keep every solid shape visible on both light panels and dark navigation rails.
// A fixed SVG also survives theme changes when stored by another application.
function balanceAvatarColor(hex: string): string {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  const target = Math.max(0.245, Math.min(0.26, luminance));
  if (target === luminance) return hex;
  const endpoint = luminance < target ? 1 : 0;
  const amount = (target - luminance) / (endpoint - luminance);
  return "#" + channels.map((channel) => {
    const value = channel + (endpoint - channel) * amount;
    const encoded = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255).toString(16).padStart(2, "0");
  }).join("");
}
export interface AvatarFallbackIdentity {
  displayName?: string | null;
  email?: string | null;
  userId?: string | null;
}

// A principal can carry its avatar in two places: the session
// payload returned by /api/auth/session (avatarUrl on the principal itself,
// available on every page) or a later profile fetch (profile.avatarUrl).
// Server Web and local clients all hit one of these shapes; this
// helper resolves the URL in the same order so the header avatar renders
// without waiting for a per-page profile request.
export interface PrincipalAvatarSource {
  userId?: string | null;
  avatarUrl?: string | null;
  profile?: { avatarUrl?: string | null; userId?: string | null } | null;
}

export function resolvePrincipalAvatarUrl(source?: PrincipalAvatarSource | null): string | undefined {
  if (!source) return undefined;
  const direct = source.avatarUrl?.trim();
  if (direct) return direct;
  const fromProfile = source.profile?.avatarUrl?.trim();
  return fromProfile || generatedAvatarUrl(source.userId || source.profile?.userId);
}

/** UUIDs give each account a stable, varied image without sending identity to an avatar service. */
export function generatedAvatarUrl(userId?: string | null): string | undefined {
  if (!userId) return undefined;
  const cached = avatarCache.get(userId);
  if (cached) return cached;
  const svg = toSvg(userId, 96, { padding: 0.08 }).replace(
    /fill="(#[a-f\d]{6})"/gi,
    (_attribute, color: string) => `fill="${balanceAvatarColor(color)}"`,
  );
  const value = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  if (avatarCache.size >= 256) avatarCache.delete(avatarCache.keys().next().value!);
  avatarCache.set(userId, value);
  return value;
}

function takeGraphemes(value: string, count: number): string {
  return Array.from(value).slice(0, count).join("");
}

// User avatars without uploaded images must resolve to the same
// textual fallback across App and Web so home, detail, settings, and
// uploader summaries never show different placeholder graphics.
export function getAvatarFallbackText(
  identity?: AvatarFallbackIdentity,
  defaultText = "WF",
): string {
  const source =
    identity?.displayName?.trim() ||
    identity?.email?.trim() ||
    identity?.userId?.trim() ||
    "";

  if (!source) {
    return defaultText;
  }

  const normalized = source.includes("@") ? source.split("@")[0] ?? source : source;
  const parts = normalized
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${takeGraphemes(parts[0] ?? "", 1)}${takeGraphemes(parts[1] ?? "", 1)}`.toUpperCase();
  }

  return takeGraphemes(parts[0] ?? normalized, 2).toUpperCase();
}
