import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachmentActionButtonClassName,
  joinClassNames,
  resolveRwiClassName,
  rwiClass,
  rwiOutputItemStatusClass,
} from "../run-workspace/styles";

const cssSource = readFileSync(
  resolve(import.meta.dirname, "../run-workspace/styles.module.css"),
  "utf8",
).replaceAll("\r\n", "\n");

// Regression test for the inlined run-workspace subset. The closure must
// keep every CSS-Modules token that the retained TypeScript can resolve
// through rwiClass(...); otherwise a token becomes undefined at runtime
// and the component renders unstyled.
describe("Inlined run-workspace subset: styles contract", () => {
  it("resolves every token from the styles.ts token maps to a defined class", () => {
    const tokens = collectReachableTokens();
    for (const token of tokens) {
      const resolved = rwiClass(token);
      expect(resolved, `token "${token}" did not resolve to a class`).not.toBe("");
    }
  });

  it("keeps every reachable class selector in the trimmed CSS source", () => {
    const tokens = collectReachableTokens();
    for (const token of tokens) {
      const selectorPattern = new RegExp(`\\.${escapeRegExp(token)}\\b`);
      expect(
        cssSource,
        `expected trimmed CSS to contain a selector for "${token}"`,
      ).toMatch(selectorPattern);
    }
  });

  it("keeps the output status badges wired to the status token map", () => {
    expect(rwiOutputItemStatusClass("running")).not.toBe("");
    expect(rwiOutputItemStatusClass("success")).not.toBe("");
    expect(rwiOutputItemStatusClass("failed")).not.toBe("");
  });
});

function collectReachableTokens(): Set<string> {
  const tokens = new Set<string>();
  collectFromFunction(attachmentActionButtonClassName, tokens);
  collectFromFunction(resolveRwiClassName, tokens);
  collectFromFunction(joinClassNames, tokens);
  collectFromFunction(rwiClass, tokens);
  collectFromFunction(rwiOutputItemStatusClass, tokens);
  return tokens;
}

function collectFromFunction(fn: Function, tokens: Set<string>): void {
  const src = fn.toString();
  const rwiClassCallRe = /rwiClass\s*\(\s*([^)]*?)\s*\)/g;
  let call: RegExpExecArray | null;
  while ((call = rwiClassCallRe.exec(src)) !== null) {
    const argsText = call[1];
    const stringRe = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;
    let sm: RegExpExecArray | null;
    while ((sm = stringRe.exec(argsText)) !== null) {
      const t = sm[0].slice(1, -1);
      if (t.startsWith("rwi-") || /^[a-z][a-z0-9_-]*$/.test(t)) {
        tokens.add(t);
      }
    }
  }
  const arrayLiteralRe = /\[\s*(?:"([^"]+)"\s*,?\s*)+\]/g;
  let arr: RegExpExecArray | null;
  while ((arr = arrayLiteralRe.exec(src)) !== null) {
    const items = arr[0];
    const stringRe = /"([^"]+)"/g;
    let sm: RegExpExecArray | null;
    while ((sm = stringRe.exec(items)) !== null) tokens.add(sm[1]);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
