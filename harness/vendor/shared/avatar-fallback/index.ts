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
  avatarUrl?: string | null;
  profile?: { avatarUrl?: string | null } | null;
}

export function resolvePrincipalAvatarUrl(source?: PrincipalAvatarSource | null): string | undefined {
  if (!source) return undefined;
  const direct = source.avatarUrl?.trim();
  if (direct) return direct;
  const fromProfile = source.profile?.avatarUrl?.trim();
  return fromProfile || undefined;
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
