import { authMailLogoPng } from "./auth-mail-logo";

const copy = {
  zh: {
    lang: "zh-CN",
    category: "账号与安全",
    codeLabel: "你的验证码",
    expires: "10 分钟内有效",
    singleUse: "仅可使用一次",
    safetyTitle: "保护你的账号",
    safety: "请勿将验证码分享给任何人。如果这不是你本人的操作，忽略这封邮件即可。",
    footer: "此邮件由 SteamHarness 自动发送，请勿直接回复。",
    purposes: {
      register: { subject: "SteamHarness 注册账号验证码", title: "创建你的 SteamHarness 账号", intro: "在注册页面输入下方验证码，验证邮箱并继续创建账号。" },
      login: { subject: "SteamHarness 登录验证码", title: "登录 SteamHarness", intro: "在登录页面输入下方验证码，完成本次登录。" },
      "bind-email": { subject: "SteamHarness 邮箱验证码", title: "验证你的邮箱", intro: "在账号安全页面输入下方验证码，完成邮箱绑定或验证。" },
      reauth: { subject: "SteamHarness 身份验证码", title: "确认是你本人操作", intro: "你正在修改账号安全设置。请输入下方验证码，继续本次操作。" },
      "password-reset": { subject: "SteamHarness 重置密码验证码", title: "重置你的密码", intro: "在找回密码页面输入下方验证码，设置新的登录密码。" },
    },
  },
  en: {
    lang: "en",
    category: "Account & security",
    codeLabel: "Your verification code",
    expires: "Expires in 10 minutes",
    singleUse: "One use only",
    safetyTitle: "Keep your account safe",
    safety: "Never share this code with anyone. If you did not request this email, you can safely ignore it.",
    footer: "This is an automated email from SteamHarness. Please do not reply.",
    purposes: {
      register: { subject: "SteamHarness: your registration code", title: "Create your SteamHarness account", intro: "Enter the code below on the registration page to verify your email and continue creating your account." },
      login: { subject: "SteamHarness: your sign-in code", title: "Sign in to SteamHarness", intro: "Enter the code below on the sign-in page to finish signing in." },
      "bind-email": { subject: "SteamHarness: verify your email", title: "Verify your email", intro: "Enter the code below on the account security page to add or verify this email address." },
      reauth: { subject: "SteamHarness: confirm your identity", title: "Confirm it’s you", intro: "You are updating your account security settings. Enter the code below to continue." },
      "password-reset": { subject: "SteamHarness: your password reset code", title: "Reset your password", intro: "Enter the code below on the password recovery page to set a new sign-in password." },
    },
  },
} as const;

export type EmailPurpose = keyof typeof copy.en.purposes;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Self-contained HTML and text alternatives for the same single-use code. */
export function renderAuthEmail(input: { code: string; purpose: EmailPurpose; locale?: string }) {
  if (typeof input.code !== "string" || input.code.length !== 6 || !/^[0-9]+$/.test(input.code)) throw new Error("Verification code must contain exactly 6 digits.");
  const messages = input.locale?.trim().toLowerCase().startsWith("zh") ? copy.zh : copy.en;
  if (!Object.hasOwn(messages.purposes, input.purpose)) throw new Error("Email purpose is invalid.");
  const purpose = messages.purposes[input.purpose];
  const logoCid = "steamharness-logo@assets";
  const text = `${purpose.title}\n\n${purpose.intro}\n\n${messages.codeLabel}: ${input.code}\n${messages.expires} · ${messages.singleUse}\n\n${messages.safety}\n\n${messages.footer}`;
  const html = `<!doctype html>
<html lang="${messages.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="format-detection" content="telephone=no">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(purpose.subject)}</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    @media only screen and (max-width: 600px) {
      .outer-padding { padding: 28px 12px !important; }
      .content-padding { padding: 28px 24px !important; }
      .safety-padding { padding: 22px 24px !important; }
      .email-heading { font-size: 25px !important; line-height: 34px !important; }
      .code-padding { padding: 22px 12px !important; }
      .verification-code { font-size: 34px !important; letter-spacing: 7px !important; }
    }
    @media (prefers-color-scheme: dark) {
      .email-body, .email-background { background-color: #0c1716 !important; }
      .email-card { background-color: #122321 !important; border-color: #29423d !important; }
      .brand-name, .email-heading, .safety-title { color: #f0fdfa !important; }
      .email-copy, .email-footer { color: #b4c8c1 !important; }
      .email-category { color: #5eead4 !important; }
      .code-panel { background-color: #14332d !important; border-color: #2a6254 !important; }
      .verification-code { color: #99f6e4 !important; }
      .code-label, .code-expiry { color: #b4d9cc !important; }
      .safety-panel { border-color: #29423d !important; }
    }
  </style>
</head>
<body class="email-body" style="margin:0;padding:0;width:100%;background-color:#f3f7f6;font-family:Arial,'Helvetica Neue','Microsoft YaHei',sans-serif;-webkit-text-size-adjust:100%;">
  <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(purpose.intro)} ${escapeHtml(messages.expires)}.</div>
  <table role="presentation" class="email-background" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="#f3f7f6" style="width:100%;background-color:#f3f7f6;">
    <tr><td align="center" class="outer-padding" style="padding:48px 20px;">
      <!--[if mso]><table role="presentation" width="560" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px;">
        <tr><td style="padding:0 0 24px;">
          <table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr>
            <td width="48" valign="middle"><img src="cid:${logoCid}" width="48" height="48" alt="SteamHarness" style="display:block;width:48px;height:48px;border:0;outline:none;text-decoration:none;"></td>
            <td valign="middle" class="brand-name" style="padding-left:12px;color:#123a34;font-size:22px;line-height:28px;font-weight:700;letter-spacing:-0.5px;">SteamHarness</td>
          </tr></table>
        </td></tr>
        <tr><td>
          <table role="presentation" class="email-card" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="#ffffff" style="width:100%;background-color:#ffffff;border:1px solid #dfe9e5;border-radius:18px;border-spacing:0;">
            <tr><td height="4" bgcolor="#14b8a6" style="height:4px;background-color:#14b8a6;border-radius:18px 18px 0 0;font-size:0;line-height:4px;">&nbsp;</td></tr>
            <tr><td class="content-padding" style="padding:36px;">
              <p class="email-category" style="margin:0 0 14px;color:#0f766e;font-size:12px;line-height:18px;font-weight:700;letter-spacing:1px;">${escapeHtml(messages.category)}</p>
              <h1 class="email-heading" style="margin:0 0 14px;color:#123a34;font-size:28px;line-height:38px;font-weight:700;letter-spacing:-0.5px;">${escapeHtml(purpose.title)}</h1>
              <p class="email-copy" style="margin:0 0 28px;color:#52665f;font-size:15px;line-height:26px;">${escapeHtml(purpose.intro)}</p>
              <table role="presentation" class="code-panel" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="#f0fdfa" style="width:100%;background-color:#f0fdfa;border:1px solid #99e4d4;border-radius:12px;">
                <tr><td align="center" class="code-padding" style="padding:24px 16px;">
                  <p class="code-label" style="margin:0 0 12px;color:#326c60;font-size:13px;line-height:20px;">${escapeHtml(messages.codeLabel)}</p>
                  <p dir="ltr" class="verification-code" style="margin:0;color:#0f766e;font-family:'SFMono-Regular',Consolas,'Liberation Mono','Courier New',monospace;font-size:40px;line-height:52px;font-weight:700;letter-spacing:8px;white-space:nowrap;font-variant-numeric:tabular-nums;user-select:all;">${input.code}</p>
                  <p class="code-expiry" style="margin:12px 0 0;color:#326c60;font-size:12px;line-height:20px;">${escapeHtml(messages.expires)} &nbsp;·&nbsp; ${escapeHtml(messages.singleUse)}</p>
                </td></tr>
              </table>
            </td></tr>
            <tr><td class="safety-panel safety-padding" style="padding:24px 36px;border-top:1px solid #e8efec;">
              <p class="safety-title" style="margin:0 0 6px;color:#284a40;font-size:13px;line-height:20px;font-weight:700;">${escapeHtml(messages.safetyTitle)}</p>
              <p class="email-copy" style="margin:0;color:#61776d;font-size:13px;line-height:22px;">${escapeHtml(messages.safety)}</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:22px 12px 0;">
          <p class="email-footer" style="margin:0;color:#5e7268;font-size:12px;line-height:20px;">${escapeHtml(messages.footer)}</p>
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
  return {
    subject: purpose.subject,
    text,
    html,
    attachments: [{
      filename: "steamharness-logo.png",
      content: Buffer.from(authMailLogoPng, "base64"),
      contentType: "image/png",
      contentDisposition: "inline" as const,
      cid: logoCid,
    }],
  };
}
