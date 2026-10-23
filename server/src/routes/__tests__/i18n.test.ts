import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  configureProjectAuthContext,
  requireAuthenticatedPrincipal,
  requirePermission,
} from "../../auth";
import {
  ensureServerI18n,
  getRequestT,
  localizeHttpErrorMessage,
  localizeServerMessage,
} from "../../i18n";
import { HttpError, toHttpError, toHttpErrorWithStatus } from "../../protocol";
import { createProjectDependencyLocks } from "@steamharness/project-dependencies";
import { createApiRouter } from "../api";
import type { Storage } from "../../storage";

// Server i18n is a startup singleton; initialize once for the whole test file.
ensureServerI18n();

test("getRequestT reads the X-SteamHarness-Locale header", () => {
  const t = getRequestT({ headers: { "x-steamharness-locale": "en" } });
  assert.equal(t("server:requestBodyTooLarge"), "Request body is too large.");
});

test("getRequestT defaults to the server default (en) without a locale header", () => {
  const t = getRequestT({ headers: {} });
  assert.equal(t("server:requestBodyTooLarge"), "Request body is too large.");
});

test("getRequestT ignores accept-language and keeps the server default", () => {
  const t = getRequestT({ headers: { "accept-language": "zh-CN,zh;q=0.9" } });
  assert.equal(t("server:requestBodyTooLarge"), "Request body is too large.");
});

test("getRequestT handles array header values", () => {
  const t = getRequestT({ headers: { "x-steamharness-locale": ["en"] } });
  assert.equal(t("server:requestBodyTooLarge"), "Request body is too large.");
});

test("localizeHttpErrorMessage resolves messageKey through the fixed-locale t()", () => {
  const t = getRequestT({ headers: { "x-steamharness-locale": "en" } });
  const error = new HttpError(409, 409, "fallback", undefined, {
    messageKey: "server:requestBodyTooLarge",
  });
  assert.equal(localizeHttpErrorMessage(error, t), "Request body is too large.");
});

test("localizeHttpErrorMessage prefers a structured descriptor over messageKey", () => {
  const t = getRequestT({ headers: { "x-steamharness-locale": "zh-CN" } });
  const error = new HttpError(
    404,
    404,
    "fallback",
    {
      steamHarnessI18n: {
        namespace: "common",
        key: "projectDependencies.validation.lockArray",
      },
    },
    { messageKey: "server:requestBodyTooLarge" },
  );

  assert.equal(localizeHttpErrorMessage(error, t), "项目依赖锁必须是数组。");
});

test("localizeHttpErrorMessage keeps the literal message when no messageKey", () => {
  const t = getRequestT({ headers: { "x-steamharness-locale": "en" } });
  const error = new HttpError(400, 400, "Literal fallback.");
  assert.equal(localizeHttpErrorMessage(error, t), "Literal fallback.");
});

test("localizeHttpErrorMessage maps stable legacy HttpError literals without changing dynamic details", () => {
  const zh = getRequestT({ headers: { "x-steamharness-locale": "zh-CN" } });
  assert.equal(
    localizeHttpErrorMessage(new HttpError(401, 401, "Unauthorized."), zh),
    "未授权。",
  );
  assert.equal(
    localizeHttpErrorMessage(new HttpError(403, 403, "Permission denied."), zh),
    "权限不足。",
  );
  assert.equal(
    localizeHttpErrorMessage(new HttpError(400, 400, "Provider detail: model-x"), zh),
    "Provider detail: model-x",
  );
});

test("unpublished role configuration guidance is localized", () => {
  const message = "Publish the project configuration template before using role-controlled configurations.";
  assert.equal(localizeServerMessage(message, getRequestT({ headers: { "x-steamharness-locale": "en" } })), message);
  assert.equal(localizeServerMessage(message, getRequestT({ headers: { "x-steamharness-locale": "zh-CN" } })), "请先发布项目配置模板，再使用按角色控制的配置。");
});

test("localizeServerMessage maps dynamic server errors with captured parameters", () => {
  const zh = getRequestT({ headers: { "x-steamharness-locale": "zh-CN" } });
  assert.equal(
    localizeServerMessage('Included project "prices" does not exist on this Server.', zh),
    "included 项目“prices”不存在于当前 Server。",
  );
  assert.equal(
    localizeServerMessage(
      'Deployment "deploy-1" cannot be prepared from status "failed".',
      zh,
    ),
    "部署“deploy-1”处于“failed”状态，不能开始准备。",
  );
  assert.equal(
    localizeServerMessage(
      'Archive entry "package.json" has an invalid size.',
      zh,
    ),
    "归档条目“package.json”的大小无效。",
  );
  assert.equal(
    localizeServerMessage('Invalid non-web client source "app".', zh),
    "非 Web 客户端来源“app”无效。",
  );
  assert.equal(
    localizeServerMessage('source must be "desktop" or "cli".', zh),
    'source 必须是 "desktop" 或 "cli"。',
  );
});

test("storage declaration and PersistentValue binding errors are localized", () => {
  const zh = getRequestT({ headers: { "x-steamharness-locale": "zh-CN" } });
  assert.equal(
    localizeHttpErrorMessage(
      new HttpError(
        409,
        409,
        "fallback",
        undefined,
        {
          messageKey: "server:projectDataStorageDeclarationRequired",
          params: { projectId: "project-1" },
        },
      ),
      zh,
    ),
    "项目“project-1”未声明 steamHarness.projectInfo.dataStorage.mode，不能访问服务器数据。请先在 package.json 中声明存储模式。",
  );
  assert.equal(
    localizeHttpErrorMessage(
      new HttpError(
        400,
        400,
        "fallback",
        undefined,
        {
          messageKey: "server:persistentValueProjectBindingMismatch",
          params: { projectId: "project-1", projectName: "other", field: "entry.projectName" },
        },
      ),
      zh,
    ),
    "访问非全局 PersistentValue 时，entry.projectName 必须与 projectId 一致。",
  );
  assert.equal(
    localizeServerMessage(
      'steamHarness.projectInfo.dataStorage.mode must be "local", "server", or "both".',
      zh,
    ),
    'steamHarness.projectInfo.dataStorage.mode 必须是 "local"、"server" 或 "both"。',
  );
});

test("toHttpError maps 413 body-too-large to a translatable messageKey", () => {
  const raw = new Error("too large");
  (raw as { status?: number }).status = 413;
  const httpError = toHttpError(raw);

  assert.equal(httpError.messageKey, "server:requestBodyTooLarge");
  assert.equal(
    getRequestT({ headers: { "x-steamharness-locale": "en" } })(httpError.messageKey!),
    "Request body is too large.",
  );
  assert.equal(getRequestT({ headers: { "x-steamharness-locale": "zh-CN" } })(httpError.messageKey!), "请求体过大。");
});

test("toHttpErrorWithStatus preserves shared validation descriptors", () => {
  let failure: unknown;
  try {
    createProjectDependencyLocks([], [{ alias: "prices", delivery: "included" }]);
  } catch (error) {
    failure = error;
  }
  const httpError = toHttpErrorWithStatus(failure, 400, 400, "Invalid project dependencies.");

  assert.equal(httpError.statusCode, 400);
  assert.equal(httpError.messageKey, "common:projectDependencies.validation.unknownSelection");
  assert.equal(
    localizeHttpErrorMessage(httpError, getRequestT({ headers: { "x-steamharness-locale": "zh-CN" } })),
    "未知的依赖选择“prices”。",
  );
});

test("real auth middleware localizes unauthenticated and forbidden responses", async () => {
  configureProjectAuthContext({
    authService: {
      async resolvePrincipal(req: { headers: { "x-test-principal"?: string } }) {
        if (req.headers["x-test-principal"] !== "user") return undefined;
        return {
          kind: "user_session",
          tokenSource: "bearer",
          userId: "i18n-user",
          profile: {
            userId: "i18n-user",
            email: "i18n@example.com",
            displayName: "I18n User",
          },
          permissions: [],
          isSystemAdmin: false,
        };
      },
    } as never,
  });
  const server = await listen((app) => {
    app.get("/authenticated", requireAuthenticatedPrincipal(), (_req, res) => {
      res.json({ errCode: 0, errMessage: "", data: {} });
    });
    app.get("/forbidden", requirePermission("system.admin"), (_req, res) => {
      res.json({ errCode: 0, errMessage: "", data: {} });
    });
  });

  try {
    const unauthorized = await fetchJson<{ errCode: number; errMessage: string }>(
      server.url("/authenticated"),
      { headers: { "X-SteamHarness-Locale": "zh-CN" } },
      { statusCode: 401 },
    );
    assert.deepEqual(unauthorized, { errCode: 401, errMessage: "未授权。" });

    const forbidden = await fetchJson<{ errCode: number; errMessage: string }>(
      server.url("/forbidden"),
      {
        headers: {
          "X-SteamHarness-Locale": "zh-CN",
          "X-Test-Principal": "user",
        },
      },
      { statusCode: 403 },
    );
    assert.deepEqual(forbidden, { errCode: 403, errMessage: "权限不足。" });
  } finally {
    await server.close();
    configureProjectAuthContext({});
  }
});

test("real API fallback route uses request-scoped localization", async () => {
  const server = await listen((app) => {
    app.use("/api", createApiRouter({} as Storage));
  });

  try {
    const response = await fetchJson<{ errCode: number; errMessage: string }>(
      server.url("/api/not-a-real-route"),
      { headers: { "X-SteamHarness-Locale": "zh-CN" } },
      { statusCode: 404 },
    );
    assert.deepEqual(response, { errCode: 404, errMessage: "API 路由不存在。" });
    assert.equal(
      localizeServerMessage("Dynamic external detail.", getRequestT({ headers: { "x-steamharness-locale": "zh-CN" } })),
      "Dynamic external detail.",
    );
  } finally {
    await server.close();
  }
});

async function listen(
  mount: (app: express.Express) => void,
): Promise<{
  close: () => Promise<void>;
  url: (path: string) => string;
}> {
  const app = express();
  mount(app);
  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  return {
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    url: (path) => `http://127.0.0.1:${address.port}${path}`,
  };
}

async function fetchJson<T = unknown & { errCode?: number; errMessage?: string }>(
  url: string,
  init?: RequestInit,
  options: { statusCode?: number } = {},
): Promise<T> {
  const response = await fetch(url, init);
  if (options.statusCode !== undefined) {
    assert.equal(response.status, options.statusCode);
  }
  return await response.json() as T;
}
