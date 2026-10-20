import { describe, expect, it } from "vitest";
import { PROJECT_CARD_ICON_NAMES } from "../index";
import { projectAvatarDataUrl, projectAvatarSvg } from "../avatar";

describe("project avatars", () => {
  it.each(PROJECT_CARD_ICON_NAMES)("renders the declared %s Lucide glyph and color pair", icon => {
    const svg = projectAvatarSvg({ icon, iconColor: "#112233", iconBackgroundColor: "#aabbcc" });
    expect(svg).toContain('stroke="#112233"');
    expect(svg).toContain('fill="#aabbcc"');
    expect(svg).toMatch(/<g\b[^>]*><(?:path|rect|circle|ellipse|polygon|line|polyline)\b/);
    expect(decodeURIComponent(projectAvatarDataUrl({ icon }).split(",")[1])).toContain("<svg");
  });

  it("normalizes invalid colors and icons and never embeds remote images or executable markup", () => {
    const svg = projectAvatarSvg({ icon: '<script>' as never, iconColor: '" onload="alert(1)', iconBackgroundColor: "url(https://example.com)", iconUrl: "https://example.com/private.png" });
    expect(svg).not.toMatch(/script|onload|example\.com|<image|url\(/);
    expect(svg).toBe(projectAvatarSvg(undefined));
    expect(projectAvatarSvg(undefined, "conversation")).not.toBe(svg);
  });
});
