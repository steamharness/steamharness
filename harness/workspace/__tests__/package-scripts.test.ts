import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("workspace package scripts", () => {
  test("runs Vitest through the package manager executable path", () => {
    const packageJsonPath = path.resolve(import.meta.dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.test).toBe("vitest run --config vitest.config.ts");
    expect(packageJson.scripts?.test).not.toMatch(/node_modules[/\\]\.bin/);
  });

  test("documents smoke checks with the standalone CLI", () => {
    const readmePath = path.resolve(
      import.meta.dirname,
      "..",
      "workflow",
      "smoke",
      "README.md",
    );
    const readme = readFileSync(readmePath, "utf8");

    expect(readme).toContain("pnpm exec workflow-code run . -- --message ok");
    expect(readme).toContain("pnpm exec workflow-code json . -- --message nope --mode fail");
    expect(readme).not.toMatch(/pnpm\s+-C\s+workspace\s+(?:executor|structure)/);
  });
});
