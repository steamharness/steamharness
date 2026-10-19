import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProjectScriptSource } from "../executor/rules";
import {
  getRuntimePlatform,
  getRuntimeLocale,
  isCli,
  isDesktop,
  projectRuntimeApi,
  STEAMHARNESS_RUNTIME_LOCALE_ENV,
  STEAMHARNESS_RUNTIME_PLATFORM_ENV,
} from "../index";

test("runtime platform defaults to CLI when no host marker is present", () => {
  withRuntimePlatform(undefined, () => {
    assert.equal(getRuntimePlatform(), "cli");
    assert.equal(isCli(), true);
    assert.equal(isDesktop(), false);
  });
});

test("runtime platform rejects the former App marker", () => {
  withRuntimePlatform("app", () => {
    assert.throws(() => getRuntimePlatform(), /no longer supported.*desktop/);
  });
});

test("runtime platform preserves local hosts and rejects removed server hosts", () => {
  withRuntimePlatform(" DESKTOP ", () => {
    assert.equal(isDesktop(), true);
    assert.equal(isCli(), false);
  });
  withRuntimePlatform("CLI", () => assert.equal(isCli(), true));
  for (const marker of ["web", "server", "unknown"]) {
    withRuntimePlatform(marker, () => {
      assert.throws(() => getRuntimePlatform(), /Unsupported STEAMHARNESS_RUNTIME_PLATFORM/);
    });
  }
});

test("workflow runtime API exposes platform helpers", () => {
  assert.equal(projectRuntimeApi.getRuntimePlatform, getRuntimePlatform);
  assert.equal(projectRuntimeApi.isCli, isCli);
  assert.equal(Object.hasOwn(projectRuntimeApi, "isWeb"), false);
  assert.equal(projectRuntimeApi.isDesktop, isDesktop);
  assert.equal(Object.hasOwn(projectRuntimeApi, "isApp"), false);
});

test("runtime locale normalizes host markers and defaults to Chinese", () => {
  withRuntimeLocale(undefined, () => {
    assert.equal(getRuntimeLocale(), "zh-CN");
  });
  withRuntimeLocale(" EN_us ", () => {
    assert.equal(getRuntimeLocale(), "en");
  });
  withRuntimeLocale("zh-TW", () => {
    assert.equal(getRuntimeLocale(), "zh-CN");
  });
  withRuntimeLocale("fr", () => {
    assert.equal(getRuntimeLocale(), "zh-CN");
  });
});

test("workflow runtime API exposes the locale helper", () => {
  assert.equal(projectRuntimeApi.getRuntimeLocale, getRuntimeLocale);
});

test("workflow structure records platform helper calls as runtime API calls", () => {
  const analysis = analyzeProjectScriptSource(`
    const outputNode = steamharness.createOutputNode({
      name: "output",
      format() {
        return { errCode: 0, errMessage: "", items: [] };
      },
    });

    export const demo = steamharness.defineProject({
      name: "runtime-platform",
      async run(input, context) {
        const platform = steamharness.getRuntimePlatform();
        const locale = steamharness.getRuntimeLocale();
        const flags = [steamharness.isCli(), steamharness.isDesktop()];
        return steamharness.runNode(outputNode, { platform, locale, flags }, context);
      },
    });
  `);

  assert.deepEqual(
    analysis.structureApiCalls
      .map((call) => call.method)
      .filter((method) => method === "getRuntimePlatform" || method === "getRuntimeLocale" || method.startsWith("is")),
    ["getRuntimePlatform", "getRuntimeLocale", "isCli", "isDesktop"],
  );
});

function withRuntimePlatform(value: string | undefined, run: () => void): void {
  const previous = process.env[STEAMHARNESS_RUNTIME_PLATFORM_ENV];

  try {
    if (value === undefined) {
      delete process.env[STEAMHARNESS_RUNTIME_PLATFORM_ENV];
    } else {
      process.env[STEAMHARNESS_RUNTIME_PLATFORM_ENV] = value;
    }
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[STEAMHARNESS_RUNTIME_PLATFORM_ENV];
    } else {
      process.env[STEAMHARNESS_RUNTIME_PLATFORM_ENV] = previous;
    }
  }
}

function withRuntimeLocale(value: string | undefined, run: () => void): void {
  const previous = process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV];

  try {
    if (value === undefined) {
      delete process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV];
    } else {
      process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV] = value;
    }
    run();
  } finally {
    if (previous === undefined) {
      delete process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV];
    } else {
      process.env[STEAMHARNESS_RUNTIME_LOCALE_ENV] = previous;
    }
  }
}
