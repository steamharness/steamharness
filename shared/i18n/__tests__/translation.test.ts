import { afterEach, describe, expect, it } from "vitest";
import {
  initI18n,
  i18n,
  readSteamHarnessI18nDescriptor,
  translateSteamHarnessError,
} from "../index";

describe("translation resolution", () => {
  it("translates fixed square avatar cropping and processing failures with Chinese fallback", () => {
    initI18n({ preference: "en" });
    expect(i18n.t("accountAvatarCropTitle", { ns: "serverWeb" })).toBe("Crop avatar");
    expect(i18n.t("accountAvatarCropDescription", { ns: "serverWeb" })).toContain("fixed 1:1 ratio");
    expect(i18n.t("accountAvatarCropReset", { ns: "serverWeb" })).toBe("Reset selection");
    expect(i18n.t("accountAvatarErrorProcessFailed", { ns: "serverWeb" })).toContain("Try again");
    initI18n({ preference: "zh-CN" });
    expect(i18n.t("accountAvatarCropTitle", { ns: "serverWeb" })).toBe("裁剪头像");
    i18n.changeLanguage("fr");
    expect(i18n.t("accountAvatarCropDescription", { ns: "serverWeb" })).toContain("固定 1:1 比例");
    expect(i18n.t("usersEditAvatarDescription", { ns: "serverWeb" })).toContain("1:1");
    expect(i18n.t("accountAvatarErrorProcessFailed", { ns: "serverWeb" })).toContain("请重试");
  });

  it("translates configuration sections and icon menus with Chinese fallback", () => {
    const labels = () => (["configurationActions", "configurationTransfer", "configurationFields", "configurationUnsaved"] as const).map(key => i18n.t(key, {ns: "serverWeb"}));
    initI18n({preference: "en"});
    expect(labels()).toEqual(["Configuration actions", "Import / export", "Configuration fields", "Unsaved changes"]);
    initI18n({preference: "zh-CN"});
    const chinese = ["配置操作", "导入 / 导出", "配置字段", "未保存的更改"];
    expect(labels()).toEqual(chinese);
    i18n.changeLanguage("fr");
    expect(labels()).toEqual(chinese);
  });
  it.each(["en", "zh-CN"])("keeps %s CLI help focused on local execution and remote storage", (locale) => {
    initI18n({ preference: locale as "en" | "zh-CN" });
    const help = i18n.t("rootHelp", { ns: "cli" });
    const workspaceCommands = help.slice(help.indexOf("  login, logout"));
    expect(workspaceCommands).toContain("download, publish, versions");
    expect(workspaceCommands).toContain("file-upload, file-download, file-delete");
    expect(workspaceCommands).not.toMatch(/\brun\b|debug-node/);
    expect(i18n.t("localHelp", { ns: "cli" })).toContain("steamharness run");
  });

  it("translates pinned preview resizing and missing configurations with Chinese fallback", () => {
    initI18n({ preference: "en" });
    expect(i18n.t("resourceCardResizeHeight")).toBe("Resize pinned preview height");
    expect(i18n.t("resourceCardConfigurationUnavailable")).toContain("configuration referenced");
    initI18n({ preference: "zh-CN" });
    expect(i18n.t("resourceCardResizeHeight")).toBe("调整固定预览高度");
    i18n.changeLanguage("fr");
    expect(i18n.t("resourceCardConfigurationUnavailable")).toContain("此预览引用的配置已不可用");
  });
  afterEach(() => {
    // 复位到默认语言，避免影响其它测试文件。
    i18n.changeLanguage("zh-CN");
  });

  it("resolves zh-CN values with the default namespace", () => {
    initI18n({ preference: "zh-CN" });
    expect(i18n.t("copy")).toBe("复制");
    expect([
      i18n.t("projectTypeWorkflow"),
      i18n.t("projectTypeConversation"),
      i18n.t("projectTypeKanban"),
    ]).toEqual(["工作流", "对话", "看板"]);
    expect(i18n.t("runStatus.success")).toBe("完成");
    expect(i18n.t("diagnosticViewAction.logs.open")).toBe("显示日志");
  });

  it("resolves en values after switching language", async () => {
    initI18n({ preference: "en" });
    expect(i18n.t("copy")).toBe("Copy");
    expect([
      i18n.t("projectTypeWorkflow"),
      i18n.t("projectTypeConversation"),
      i18n.t("projectTypeKanban"),
    ]).toEqual(["Workflow", "Conversation", "Kanban"]);
    expect(i18n.t("runStatus.success")).toBe("Done");
    expect(i18n.t("diagnosticViewAction.logs.open")).toBe("Show Logs");
    expect(i18n.t("attachmentPreview", { name: "demo.png" })).toBe("Preview demo.png");
  });

  it("keeps account invitation messages available in both Server Web locales", () => {
    initI18n({ preference: "zh-CN" });
    expect(i18n.t("accountInviteDescription", {
      ns: "serverWeb",
      email: "owner@example.com",
    })).toBe("为 owner@example.com 设置初始密码并激活 SteamHarness 账号。");

    initI18n({ preference: "en" });
    expect(i18n.t("accountInviteExpiresAt", {
      ns: "serverWeb",
      expiresAt: "2026-08-27 10:00:00",
    })).toBe("This single-use link expires 2026-08-27 10:00:00.");
  });

  it("uses host system languages for the system preference", () => {
    initI18n({ preference: "system", systemLanguages: ["zh-Hans-CN", "en-CN"] });
    expect(i18n.language).toBe("zh-CN");
    expect(i18n.t("copy")).toBe("复制");
  });

  it("resolves plan actions in both Desktop locales and falls back to Chinese", () => {
    initI18n({ preference: "zh-CN" });
    expect([i18n.t("desktop:planExecute"), i18n.t("desktop:planChangeInstructions"), i18n.t("desktop:planRevise")])
      .toEqual(["按计划执行", "修改要求", "修改计划"]);
    initI18n({ preference: "en" });
    expect([i18n.t("desktop:planExecute"), i18n.t("desktop:planChangeInstructions"), i18n.t("desktop:planRevise")])
      .toEqual(["Run the plan", "Change instructions", "Revise the plan"]);
    i18n.changeLanguage("fr");
    expect(i18n.t("desktop:planExecute")).toBe("按计划执行");
  });

  it("reads descriptors and fallback messages through nested error causes", () => {
    initI18n({ preference: "en" });
    const error = new Error("Outer fallback", {
      cause: {
        errMessage: "Nested fallback",
        data: {
          steamHarnessI18n: {
            namespace: "common",
            key: "projectServerLoginRequired",
          },
        },
      },
    });

    expect(readSteamHarnessI18nDescriptor(error)).toEqual({
      namespace: "common",
      key: "projectServerLoginRequired",
    });
    expect(translateSteamHarnessError(error)).toBe(
      "SteamHarness Server login is not configured. Sign in to the server in Desktop or workspace CLI first.",
    );
  });

  it("translates Kanban upload errors in both Desktop locales with Chinese fallback", () => {
    const error = { message: "Readback mismatch", steamHarnessI18n: { namespace: "desktop", key: "kanbanUploadReadbackMismatch" } };
    initI18n({ preference: "en" });
    expect(translateSteamHarnessError(error)).toBe("Server file readback does not match the selected file. The reference was not saved.");
    expect(i18n.t("desktop:kanbanUploadFileReadFailed")).toBe("The selected file could not be read. Select it again.");
    initI18n({ preference: "zh-CN" });
    expect(translateSteamHarnessError(error)).toBe("服务器文件读回与所选文件不一致，未保存文件引用。");
    expect(i18n.t("desktop:kanbanUploadFileReadFailed")).toBe("无法读取所选文件，请重新选择。");
    i18n.changeLanguage("fr");
    expect(i18n.t("desktop:kanbanUploadFileInvalid")).toBe("请选择不超过 50 MiB 的普通文件。");
  });

  it("rejects the former App namespace instead of translating it as Desktop", () => {
    expect(readSteamHarnessI18nDescriptor({
      namespace: "app",
      key: "settings",
    })).toBeUndefined();
    expect(readSteamHarnessI18nDescriptor({
      namespace: "desktop",
      key: "settings",
    })).toEqual({ namespace: "desktop", key: "settings" });
  });

  it("translates Kanban preview sizes in both Desktop locales with Chinese fallback", () => {
    const labels = () => (["kanbanPreviewSize", "kanbanPreviewFullscreen", "kanbanPreviewPhone", "kanbanPreviewTablet", "kanbanPreviewCard"] as const)
      .map((key) => i18n.t(`desktop:${key}`));
    initI18n({ preference: "en" });
    expect(labels()).toEqual(["Kanban preview size", "Full screen", "Phone", "Tablet", "Small card"]);
    initI18n({ preference: "zh-CN" });
    expect(labels()).toEqual(["看板预览尺寸", "全屏", "手机", "平板", "小卡片"]);
    i18n.changeLanguage("fr");
    expect(labels()).toEqual(["看板预览尺寸", "全屏", "手机", "平板", "小卡片"]);
  });

  it("translates Kanban resize controls in both Desktop locales with Chinese fallback", () => {
    const labels = () => (["kanbanPreviewAdjustSize", "kanbanPreviewResetSize", "kanbanPreviewResizeHandle", "kanbanPreviewWidth", "kanbanPreviewHeight"] as const)
      .map((key) => i18n.t(`desktop:${key}`));
    initI18n({ preference: "en" });
    expect(labels()).toEqual(["Adjust preview size", "Restore default size", "Resize preview width and height", "Width (px)", "Height (px)"]);
    initI18n({ preference: "zh-CN" });
    const chinese = ["调整预览尺寸", "恢复默认尺寸", "调整预览宽高", "宽度 (px)", "高度 (px)"];
    expect(labels()).toEqual(chinese);
    i18n.changeLanguage("fr");
    expect(labels()).toEqual(chinese);
  });

  it("reads errMessage fallbacks without looping on cyclic error payloads", () => {
    const failure: Record<string, unknown> = { errMessage: "Server fallback" };
    failure.cause = failure;

    expect(readSteamHarnessI18nDescriptor(failure)).toBeUndefined();
    expect(translateSteamHarnessError(failure)).toBe("Server fallback");
  });
});
