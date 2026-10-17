import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachmentActionButtonClassName,
  joinClassNames,
  resolveRwiClassName,
  rwiClass,
  runActionButtonClassName,
} from "../run-workspace/styles";

const cssSource = readFileSync(
  resolve(import.meta.dirname, "../run-workspace/styles.module.css"),
  "utf8",
).replaceAll("\r\n", "\n");

// Regression test for the inlined run-workspace subset. The closure must
// keep every CSS-Modules token that the retained TypeScript can resolve
// through rwiClass(...); otherwise a token becomes undefined at runtime
// and the component renders unstyled. The raw-text check defends against
// a token being declared in styles.ts but missing from the trimmed CSS.
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

  it("keeps the hard assertions required by the kanban settings layout", () => {
    // These are explicit acceptance criteria from the styles test
    // contract; they must remain even after aggressive trimming.
    expect(cssSource).toContain(".rwi-params-form.settings");
    expect(cssSource).toContain(".rwi-option-list.segmented");
    expect(cssSource).toContain(".rwi-option-color-swatch");
    expect(cssSource).toContain("resize: vertical");
    expect(cssSource).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(cssSource).toContain(
      "grid-template-columns: repeat(auto-fit, minmax(min(72px, 100%), 1fr))",
    );
    expect(cssSource).not.toContain("min-width: min(92px, 100%)");
  });
});

function collectReachableTokens(): Set<string> {
  const tokens = new Set<string>();

  // runActionButtonClassName composes ["rwi-button", variant token]
  collectFromFunction(runActionButtonClassName, tokens);
  // attachmentActionButtonClassName composes ["rwi-icon-button", "rwi-attachment-action-button"]
  collectFromFunction(attachmentActionButtonClassName, tokens);
  // resolveRwiClassName and joinClassNames reference rwiClass internally.
  collectFromFunction(resolveRwiClassName, tokens);
  collectFromFunction(joinClassNames, tokens);
  collectFromFunction(rwiClass, tokens);

  return tokens;
}

function collectFromFunction(fn: Function, tokens: Set<string>): void {
  // Inspect the source string for the rwiClass calls inside the helper.
  // Only string literals preceded by a "rwi-" prefix count as class
  // tokens; random internal literals like "string" are ignored.
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
  // Token-map literal arrays in the body.
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
