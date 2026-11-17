import { describe, expect, it } from "vitest";
import { toSvg } from "jdenticon/browser";
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
  function svgFor(userId: string): string {
    const avatar = generatedAvatarUrl(userId)!;
    return decodeURIComponent(avatar.slice(avatar.indexOf(",") + 1));
  }

  function luminance(hex: string): number {
    const rgb = [1, 3, 5].map((offset) => {
      const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
  }

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

  it("keeps every solid fill readable on light and dark host surfaces", () => {
    const surfaces = ["#ffffff", "#f7f8f7", "#f1f3f2", "#f4f6f5", "#121214", "#222222", "#333f3c"];
    for (let index = 0; index < 512; index++) {
      const userId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      const fills = [...svgFor(userId).matchAll(/fill="(#[a-f\d]{6})"/gi)].map((match) => match[1]!);
      expect(fills.length).toBeGreaterThan(0);
      for (const fill of fills) {
        for (const surface of surfaces) {
          const values = [luminance(fill), luminance(surface)].sort((a, b) => a - b);
          const contrast = (values[1]! + 0.05) / (values[0]! + 0.05);
          expect(contrast, `${userId}: ${fill} on ${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("preserves geometric identity and transparency when balancing colors", () => {
    const userId = "account-with-an-existing-geometric-avatar";
    const original = toSvg(userId, 96, { padding: 0.08 });
    const shapes = (svg: string) => svg.replace(/fill="#[a-f\d]{6}"/gi, 'fill="color"');
    expect(shapes(svgFor(userId))).toBe(shapes(original));
    expect(svgFor(userId)).not.toMatch(/<rect|<style|prefers-color-scheme|currentColor/i);
  });

  it("keeps the same SVG across theme changes and cache eviction", () => {
    const userId = "account-theme-stability";
    const avatar = generatedAvatarUrl(userId);
    document.documentElement.dataset.theme = "dark";
    try {
      expect(generatedAvatarUrl(userId)).toBe(avatar);
      for (let index = 0; index < 256; index++) generatedAvatarUrl(`other-account-${index}`);
      expect(generatedAvatarUrl(userId)).toBe(avatar);
      document.documentElement.dataset.theme = "light";
      expect(generatedAvatarUrl(userId)).toBe(avatar);
    } finally {
      delete document.documentElement.dataset.theme;
    }
  });
});
