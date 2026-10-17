import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("server dev script delegates branch-aware source and dist selection", () => {
  const packageJsonPath = path.resolve(import.meta.dirname, "../../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };

  const devScript = packageJson.scripts?.dev;
  // assert.equal only validates at runtime; narrow the union for the TS
  // compiler so the assert.match calls below see a real `string`.
  if (typeof devScript !== "string") {
    assert.fail(`Expected scripts.dev in ${packageJsonPath} to be a string`);
  }

  assert.equal(devScript, "node scripts/dev.mjs");
  assert.equal(packageJson.scripts?.["start:local"], "node scripts/dev.mjs --no-hmr");
  const runner = readFileSync(path.resolve(import.meta.dirname, "../../scripts/dev.mjs"), "utf8");
  assert.match(runner, /NODE_ENV:\s*"development"/);
  assert.match(runner, /STEAMHARNESS_SERVER_DEV:\s*"1"/);
  assert.match(runner, /--conditions=development/);
  assert.match(runner, /"watch"/);
  assert.match(runner, /"build:all"/);
  assert.match(runner, /"dist", "index\.js"/);
});

test("server package exposes launchd helper scripts for production keepalive", () => {
  const packageJsonPath = path.resolve(import.meta.dirname, "../../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };

  const installScript = packageJson.scripts?.["deploy:launchd:install"];
  const printScript = packageJson.scripts?.["deploy:launchd:print"];

  if (typeof installScript !== "string" || typeof printScript !== "string") {
    assert.fail(`Expected launchd scripts in ${packageJsonPath}`);
  }

  assert.match(installScript, /scripts\/launchd\.mjs install/);
  assert.match(printScript, /scripts\/launchd\.mjs print/);
});

test("server package does not expose the retired local download service", () => {
  const packageJsonPath = path.resolve(import.meta.dirname, "../../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.["download:start"], undefined);
  assert.equal(packageJson.scripts?.["download:launchd:install"], undefined);
});

test("server package exposes docs service scripts for published docs releases", () => {
  const packageJsonPath = path.resolve(import.meta.dirname, "../../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };

  const startScript = packageJson.scripts?.["docs:start"];
  const launchdScript = packageJson.scripts?.["docs:launchd:install"];

  if (typeof startScript !== "string" || typeof launchdScript !== "string") {
    assert.fail(`Expected docs scripts in ${packageJsonPath}`);
  }

  assert.match(startScript, /scripts\/docs-server\.mjs start/);
  assert.match(launchdScript, /scripts\/docs-launchd\.mjs install/);
});

test("server package keeps Server Web and removes the App Web Studio service", () => {
  const packageJsonPath = path.resolve(import.meta.dirname, "../../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.["studio:start"], undefined);
  assert.equal(packageJson.scripts?.["studio:serve"], undefined);
  assert.equal(packageJson.scripts?.["studio:launchd:install"], undefined);
  assert.equal(typeof packageJson.scripts?.["build:web"], "string");
});

test("server source keeps dev and deploy default ports split for issue #97", () => {
  const entrySource = readFileSync(path.resolve(import.meta.dirname, "../index.ts"), "utf8");
  const portSource = readFileSync(path.resolve(import.meta.dirname, "../dev-port.ts"), "utf8");

  // The defaults live in dev-port.ts so non-entry modules resolve the same value;
  // the entry point keeps the dev-versus-production selection between them.
  assert.match(portSource, /export const DEFAULT_DEV_SERVER_PORT = 7126;/);
  assert.match(portSource, /export const DEFAULT_PRODUCTION_SERVER_PORT = 7130;/);
  assert.match(entrySource, /STEAMHARNESS_SERVER_DEV === "1"\s*\n\s*\?\s*DEFAULT_DEV_SERVER_PORT\s*\n\s*:\s*DEFAULT_PRODUCTION_SERVER_PORT;/);
});

test("server env loader keeps production startup on .env.production before dev defaults", () => {
  const sourcePath = path.resolve(import.meta.dirname, "../env.ts");
  const source = readFileSync(sourcePath, "utf8");

  assert.match(source, /\.env\.production/);
  assert.match(source, /inferServerEnvMode/);
  assert.match(source, /STEAMHARNESS_SERVER_DEV === "1"/);
});

test("server production env example lets a standalone checkout resolve its own repository root", () => {
  // validates the committed variable-name reference without reading
  // or echoing the ignored production env used by this machine.
  const envPath = path.resolve(import.meta.dirname, "../../.env.production.example");
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/u);

  assert.equal(lines.some((line) => /^STEAMHARNESS_REPO_ROOT=\s*$/u.test(line)), true);
  assert.equal(lines.some((line) => /^STEAMHARNESS_REPO_ROOT=.*steamharness(?:[\\/]|$)/u.test(line)), false);
});

test("server allows only required native dependency install scripts with pnpm 10", () => {
  const workspacePath = path.resolve(import.meta.dirname, "../../pnpm-workspace.yaml");
  const source = readFileSync(workspacePath, "utf8");

  assert.match(source, /^onlyBuiltDependencies:\n(?:  - .+\n)+/mu);
  assert.match(source, /^  - esbuild$/mu);
  assert.doesNotMatch(source, /^  - node-pty$/mu);
  assert.doesNotMatch(source, /^allowBuilds:/mu);
});

test("server tsconfig resolves steamharness from its exact npm dependency", () => {
  const packageJsonPath = path.resolve(import.meta.dirname, "../../package.json");
  const tsconfigPath = path.resolve(import.meta.dirname, "../../tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
    compilerOptions?: { paths?: Record<string, string[]> };
    include?: string[];
  };

  assert.equal(tsconfig.compilerOptions?.paths?.["steamharness"], undefined);
  assert.deepEqual(tsconfig.include, ["src/**/*.ts"]);
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.match(manifest.dependencies?.["steamharness"] ?? "", /^\d+\.\d+\.\d+(?:-\d{11})?$/);
});

test("server production bundle inlines TypeScript-only workspace packages", () => {
  const packageJsonPath = path.resolve(import.meta.dirname, "../../package.json");
  const configPath = path.resolve(import.meta.dirname, "../../tsup.config.ts");
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const source = readFileSync(configPath, "utf8");

  const workspacePackages = Object.entries(manifest.dependencies ?? {})
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([packageName]) => packageName);
  assert.ok(workspacePackages.length > 0);
  for (const packageName of workspacePackages) {
    assert.match(
      source,
      new RegExp(`noExternal:\\s*\\[[^\\]]*"${packageName}"`),
      `${packageName} must be bundled into the production Server output`,
    );
  }
});

test("server web tests resolve from the standalone Server repository root", () => {
  const configPath = path.resolve(import.meta.dirname, "../../vitest.config.ts");
  const source = readFileSync(configPath, "utf8");

  assert.match(source, /root:\s*import\.meta\.dirname/);
  assert.match(source, /web\/src\/\*\*\/__tests__\/\*\*\/\*\.test\.tsx/);
});
