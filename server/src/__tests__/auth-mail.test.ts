import assert from "node:assert/strict";
import test from "node:test";
import nodemailer from "nodemailer";
import { mailConfigured, sendAuthEmail } from "../auth-mail";
import { renderAuthEmail, type EmailPurpose } from "../auth-mail-template";

const purposes: EmailPurpose[] = ["register", "login", "bind-email", "reauth", "password-reset"];
const titles = {
  zh: ["创建你的 SteamHarness 账号", "登录 SteamHarness", "验证你的邮箱", "确认是你本人操作", "重置你的密码"],
  en: ["Create your SteamHarness account", "Sign in to SteamHarness", "Verify your email", "Confirm it’s you", "Reset your password"],
};

for (const locale of ["zh", "en"] as const) {
  for (const [index, purpose] of purposes.entries()) {
    test(`${locale} ${purpose} mail keeps the code, purpose and safety information in both alternatives`, () => {
      const message = renderAuthEmail({ code: "012345", purpose, locale });
      assert.match(message.subject, /SteamHarness/);
      assert.ok(message.html.includes(titles[locale][index]));
      assert.ok(message.text.includes(titles[locale][index]));
      assert.match(message.html, /class="verification-code"[^>]*>012345<\/p>/);
      assert.match(message.text, /: 012345\n/);
      assert.equal(message.html.match(/012345/g)?.length, 1, "Code stays a single selectable text node");
      assert.equal(message.text.match(/012345/g)?.length, 1);
      assert.match(message.html, new RegExp(`<html lang="${locale === "zh" ? "zh-CN" : "en"}">`));
      const expiry = locale === "zh" ? "10 分钟内有效" : "Expires in 10 minutes";
      const singleUse = locale === "zh" ? "仅可使用一次" : "One use only";
      const safety = locale === "zh" ? "请勿将验证码分享给任何人" : "Never share this code with anyone";
      for (const text of [message.html, message.text]) {
        assert.ok(text.includes(expiry));
        assert.ok(text.includes(singleUse));
        assert.ok(text.includes(safety));
        assert.ok(text.includes(locale === "zh" ? "忽略这封邮件" : "ignore it"));
      }
      assert.doesNotMatch(message.text, /<[^>]+>/);
    });
  }
}

test("mail logo is a self-contained PNG referenced by its inline Content-ID", () => {
  const message = renderAuthEmail({ code: "123456", purpose: "bind-email", locale: "zh-CN" });
  const logo = message.attachments[0];
  assert.equal(message.attachments.length, 1);
  assert.ok(message.html.includes(`src="cid:${logo.cid}"`));
  assert.equal(logo.contentType, "image/png");
  assert.equal(logo.contentDisposition, "inline");
  assert.equal(logo.content.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(logo.content.readUInt32BE(16), 256);
  assert.equal(logo.content.readUInt32BE(20), 256);
  assert.match(message.html, /alt="SteamHarness"/);
  assert.doesNotMatch(message.html, /(?:src|href)="(?:https?:|data:|file:)/i);
  assert.doesNotMatch(message.html, /<script|<form|<iframe|display:\s*(?:grid|flex)/i);
});

test("regional Chinese locales and the English fallback render valid mail", () => {
  for (const locale of ["zh-CN", "ZH-tw", " zh-Hans "]) {
    assert.match(renderAuthEmail({ code: "000000", purpose: "login", locale }).html, /<html lang="zh-CN">/);
  }
  for (const locale of [undefined, "en-GB", "fr"]) {
    assert.match(renderAuthEmail({ code: "999999", purpose: "login", locale }).html, /<html lang="en">/);
  }
});

test("mail rejects malformed codes and unknown purposes before interpolating HTML", () => {
  for (const code of ["12345", "1234567", "123456\n", "123456\r\n", "12 345", "<img/>", "１２３４５６"]) {
    assert.throws(() => renderAuthEmail({ code, purpose: "login" }), /exactly 6 digits/);
  }
  for (const purpose of ["unknown", "__proto__", "constructor"]) {
    assert.throws(() => renderAuthEmail({ code: "123456", purpose: purpose as EmailPurpose }), /purpose is invalid/);
  }
});

function configureTestSmtp(t: test.TestContext) {
  const values = {
    STEAMHARNESS_SERVER_SMTP_HOST: "smtp.example.test",
    STEAMHARNESS_SERVER_SMTP_FROM: "SteamHarness <accounts@example.test>",
    STEAMHARNESS_SERVER_SMTP_PORT: "587",
    STEAMHARNESS_SERVER_SMTP_SECURE: "false",
    STEAMHARNESS_SERVER_SMTP_USER: "test-user",
    STEAMHARNESS_SERVER_SMTP_PASSWORD: "test-only-password",
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test("SMTP sends HTML, plain text and the inline logo together and closes the transport", async t => {
  configureTestSmtp(t);
  const sent: (ReturnType<typeof renderAuthEmail> & { from: string; to: string })[] = [];
  let closed = 0;
  const factory = t.mock.method(nodemailer, "createTransport", (() => ({
    async sendMail(message: typeof sent[number]) { sent.push(message); },
    close() { closed++; },
  })) as never);
  await sendAuthEmail({ email: "recipient@example.test", code: "012345", purpose: "password-reset", locale: "zh" });
  assert.equal(factory.mock.callCount(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "SteamHarness <accounts@example.test>");
  assert.equal(sent[0].to, "recipient@example.test");
  assert.match(sent[0].html, /重置你的密码/);
  assert.match(sent[0].text, /012345/);
  assert.equal(sent[0].attachments.length, 1);
  assert.equal(closed, 1);
});

test("SMTP failure retains the public error and closes the transport", async t => {
  configureTestSmtp(t);
  let closed = 0;
  t.mock.method(nodemailer, "createTransport", (() => ({
    async sendMail() { throw new Error("SMTP backend detail"); },
    close() { closed++; },
  })) as never);
  await assert.rejects(sendAuthEmail({ email: "recipient@example.test", code: "012345", purpose: "login" }),
    { message: "Email could not be sent. Try again later." });
  assert.equal(closed, 1);
});

test("invalid mail configuration or code never opens an SMTP connection", async t => {
  configureTestSmtp(t);
  const factory = t.mock.method(nodemailer, "createTransport", (() => { throw new Error("Unexpected SMTP connection"); }) as never);
  process.env.STEAMHARNESS_SERVER_SMTP_PORT = "not-a-port";
  await assert.rejects(sendAuthEmail({ email: "recipient@example.test", code: "012345", purpose: "login" }), /Email service is unavailable/);
  process.env.STEAMHARNESS_SERVER_SMTP_PORT = "587";
  await assert.rejects(sendAuthEmail({ email: "recipient@example.test", code: "123456\n", purpose: "login" }), /exactly 6 digits/);
  assert.equal(factory.mock.callCount(), 0);
  assert.equal(mailConfigured({ STEAMHARNESS_SERVER_SMTP_HOST: " ", STEAMHARNESS_SERVER_SMTP_FROM: "test@example.test" }), false);
});

test("local MIME generation preserves text, HTML and the related logo without SMTP", async () => {
  const message = renderAuthEmail({ code: "012345", purpose: "login", locale: "en" });
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  try {
    const result = await transport.sendMail({ ...message, from: "accounts@example.test", to: "recipient@example.test" });
    const mime = result.message.toString();
    assert.match(mime, /Content-Type: multipart\/alternative/i);
    assert.match(mime, /Content-Type: multipart\/related/i);
    assert.match(mime, /Content-Type: text\/plain; charset=utf-8/i);
    assert.match(mime, /Content-Type: text\/html; charset=utf-8/i);
    assert.match(mime, /Content-Type: image\/png/i);
    assert.ok(mime.includes(`Content-ID: <${message.attachments[0].cid}>`));
    assert.match(mime, /Content-Disposition: inline;/i);
    assert.match(mime, /Your verification code: 012345/);
    assert.ok(mime.replace(/\r?\n/g, "").includes(message.attachments[0].content.toString("base64")));
  } finally { transport.close(); }
});
