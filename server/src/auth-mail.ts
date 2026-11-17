import nodemailer from "nodemailer";
import { renderAuthEmail, type EmailPurpose } from "./auth-mail-template";

export type { EmailPurpose } from "./auth-mail-template";

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
  const message = renderAuthEmail(input);
  const transport = nodemailer.createTransport({
    host, port, secure, requireTLS: !secure && !["localhost", "127.0.0.1", "::1"].includes(host),
    ...(env.STEAMHARNESS_SERVER_SMTP_USER ? { auth: { user: env.STEAMHARNESS_SERVER_SMTP_USER, pass: env.STEAMHARNESS_SERVER_SMTP_PASSWORD || "" } } : {}),
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    logger: false, debug: false,
  });
  try {
    await transport.sendMail({
      ...message,
      from: env.STEAMHARNESS_SERVER_SMTP_FROM, to: input.email,
    });
  } catch { throw new Error("Email could not be sent. Try again later."); }
  finally { transport.close(); }
}
