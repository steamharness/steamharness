import { describe, expect, it } from "vitest";
import { generatedAvatarUrl, getAvatarFallbackText, resolvePrincipalAvatarUrl } from "@steamharness/avatar-fallback";

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


describe("generated account avatars", () => {
  it("keeps an account's geometric SVG stable without exposing its identity", () => {
    const userId = "account-<private>&identifier";
    const avatar = generatedAvatarUrl(userId)!;
    expect(avatar).toBe(generatedAvatarUrl(userId));
    expect(avatar).toMatch(/^data:image\/svg\+xml,/);
    const svg = decodeURIComponent(avatar.slice(avatar.indexOf(",") + 1));
    expect(svg).toContain("<svg");
    expect(svg).not.toContain(userId);
    expect(svg).not.toMatch(/<script|href=|<image/i);
    expect(avatar).not.toBe(generatedAvatarUrl("another-account"));
  });

  it("uses a generated avatar only when the account has no uploaded image", () => {
    expect(resolvePrincipalAvatarUrl({userId:"account"})).toBe(generatedAvatarUrl("account"));
    expect(resolvePrincipalAvatarUrl({profile:{userId:"account"}})).toBe(generatedAvatarUrl("account"));
    expect(resolvePrincipalAvatarUrl({userId:"account",avatarUrl:"/storage/avatar.png"})).toBe("/storage/avatar.png");
  });
});
