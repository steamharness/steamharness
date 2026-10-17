import { describe, expect, it } from "vitest";
import { createUtf8StreamDecoder } from "../index";

describe("UTF-8 stream decoder", () => {
  it("preserves a multibyte character split across separate chunks", () => {
    const decoder = createUtf8StreamDecoder();
    const source = "目录：__fixtures__/";
    const bytes = Buffer.from(source, "utf8");
    const colonOffset = Buffer.byteLength("目录", "utf8");
    const chunks = [
      bytes.subarray(0, colonOffset + 1),
      bytes.subarray(colonOffset + 1, colonOffset + 2),
      bytes.subarray(colonOffset + 2),
    ];

    const decoded = chunks.map((chunk) => decoder.write(chunk)).join("") + decoder.end();

    expect(decoded).toBe(source);
    expect(decoded).not.toContain("�");
  });
});
