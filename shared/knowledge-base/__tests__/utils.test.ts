import { describe, expect, it } from "vitest";
import { getKnowledgeMarkdownByteLength } from "../utils";

describe("knowledge markdown utilities", () => {
  it("matches UTF-8 byte lengths for multi-byte and malformed UTF-16 input", () => {
    const markdown = "ASCII 中文 emoji 😀 isolated \ud800";

    expect(getKnowledgeMarkdownByteLength(markdown)).toBe(new TextEncoder().encode(markdown).byteLength);
  });

  it("stops once a caller-provided byte threshold has been crossed", () => {
    expect(getKnowledgeMarkdownByteLength("中中中", 5)).toBe(6);
    expect(getKnowledgeMarkdownByteLength("abcdef", 5)).toBe(6);
  });
});
