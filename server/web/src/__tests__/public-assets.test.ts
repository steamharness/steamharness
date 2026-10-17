import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(import.meta.dirname, "../..");
const repositoryRoot = path.resolve(webRoot, "..");

describe("Server Web public assets", () => {
  it("keeps the HTML icons backed by tracked brand resources", () => {
    const indexHtml = readFileSync(path.join(webRoot, "index.html"), "utf8");
    expect(indexHtml).toContain('href="/favicon.png"');
    expect(indexHtml).toContain('href="/apple-touch-icon.png"');

    for (const [publicPath, brandPath] of [
      ["favicon.png", "steamharness-icon-32.png"],
      ["apple-touch-icon.png", "steamharness-icon-256.png"],
      ["brand/steamharness-icon-mark.svg", "steamharness-icon-mark.svg"],
      ["brand/steamharness-icon.svg", "steamharness-icon.svg"],
    ]) {
      expect(readFileSync(path.join(webRoot, "public", publicPath))).toEqual(
        readFileSync(path.join(repositoryRoot, "assets", "brand", brandPath)),
      );
    }
  });
});
