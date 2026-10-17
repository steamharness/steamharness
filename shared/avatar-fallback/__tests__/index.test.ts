import { describe, expect, it } from "vitest";
import { getAvatarFallbackText, resolvePrincipalAvatarUrl } from "@steamharness/avatar-fallback";

describe("avatar-fallback package", () => {
  it("prefers display name initials", () => {
    expect(getAvatarFallbackText({ displayName: "Workflow User" })).toBe("WU");
    expect(getAvatarFallbackText({ displayName: "Admin" })).toBe("AD");
  });

  it("falls back to email local-part initials", () => {
    expect(getAvatarFallbackText({ email: "user@example.com" })).toBe("US");
  });

  it("falls back to the user id when display name and email are missing", () => {
    expect(getAvatarFallbackText({ userId: "user-beta" })).toBe("UB");
    expect(getAvatarFallbackText({ userId: "admin_session" })).toBe("AS");
  });

  it("uses the provided default when no identity exists", () => {
    expect(getAvatarFallbackText(undefined)).toBe("WF");
    expect(getAvatarFallbackText({}, "U")).toBe("U");
  });
});

describe("resolvePrincipalAvatarUrl", () => {
  it("returns undefined for missing or empty sources", () => {
    expect(resolvePrincipalAvatarUrl(undefined)).toBeUndefined();
    expect(resolvePrincipalAvatarUrl(null)).toBeUndefined();
    expect(resolvePrincipalAvatarUrl({})).toBeUndefined();
    expect(resolvePrincipalAvatarUrl({ avatarUrl: "" })).toBeUndefined();
    expect(resolvePrincipalAvatarUrl({ avatarUrl: "  " })).toBeUndefined();
  });

  it("prefers the direct avatarUrl over the nested profile one", () => {
    expect(
      resolvePrincipalAvatarUrl({
        avatarUrl: "https://cdn/session.png",
        profile: { avatarUrl: "https://cdn/profile.png" },
      }),
    ).toBe("https://cdn/session.png");
  });

  it("falls back to profile.avatarUrl when the principal has none", () => {
    expect(resolvePrincipalAvatarUrl({ profile: { avatarUrl: "https://cdn/profile.png" } })).toBe("https://cdn/profile.png");
  });

  it("trims surrounding whitespace before returning", () => {
    expect(resolvePrincipalAvatarUrl({ avatarUrl: "  https://cdn/x.png  " })).toBe("https://cdn/x.png");
  });
});
