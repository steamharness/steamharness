import nodemailer from "nodemailer";

export type EmailPurpose = "register" | "login" | "bind-email" | "reauth" | "password-reset";

export function mailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.STEAMHARNESS_SERVER_SMTP_HOST?.trim() && env.STEAMHARNESS_SERVER_SMTP_FROM?.trim());
}

export async function sendAuthEmail(input: { email: string; code: string; purpose: EmailPurpose; locale?: string }): Promise<void> {
  const env = process.env;
  if (!mailConfigured(env)) throw new Error("Email service is unavailable.");
  const host = env.STEAMHARNESS_SERVER_SMTP_HOST!.trim();
  const secure = env.STEAMHARNESS_SERVER_SMTP_SECURE === "true" || env.STEAMHARNESS_SERVER_SMTP_SECURE === "1";
  const port = Number(env.STEAMHARNESS_SERVER_SMTP_PORT || (secure ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Email service is unavailable.");
  const transport = nodemailer.createTransport({
    host, port, secure, requireTLS: !secure && !["localhost", "127.0.0.1", "::1"].includes(host),
    ...(env.STEAMHARNESS_SERVER_SMTP_USER ? { auth: { user: env.STEAMHARNESS_SERVER_SMTP_USER, pass: env.STEAMHARNESS_SERVER_SMTP_PASSWORD || "" } } : {}),
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    logger: false, debug: false,
  });
  const zh = input.locale?.toLowerCase().startsWith("zh");
  const purpose = (zh ? {
    register: "注册账号", login: "登录", "bind-email": "验证邮箱", reauth: "验证身份", "password-reset": "重置密码",
  } : {
    register: "create your account", login: "sign in", "bind-email": "verify your email", reauth: "verify your identity", "password-reset": "reset your password",
  })[input.purpose];
  try {
    await transport.sendMail({
      from: env.STEAMHARNESS_SERVER_SMTP_FROM, to: input.email,
      subject: zh ? `SteamHarness ${purpose}验证码` : `SteamHarness: ${purpose}`,
      text: zh ? `你正在${purpose}。验证码：${input.code}\n\n验证码 10 分钟内有效，只能使用一次。请勿分享验证码。若不是你本人操作，请忽略此邮件。`
        : `Use ${input.code} to ${purpose}.\n\nThis code expires in 10 minutes and can be used once. Do not share it. If you did not request it, ignore this email.`,
    });
  } catch { throw new Error("Email could not be sent. Try again later."); }
  finally { transport.close(); }
}
