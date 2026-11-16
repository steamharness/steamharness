import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { apiClient } from "../api";
import { isApiSuccess } from "../types";
import { readLoginReturnTo } from "../utils/routes";

export interface AuthConfig { registrationEnabled: boolean; mailAvailable: boolean }
export interface CodeChallenge { challengeId: string; retryAfterSeconds: number }
export function LoginPage({ mode = "login", onAuthenticated, message }: {
  mode?: "login" | "register" | "forgot-password";
  onAuthenticated: () => void;
  message?: string;
}) {
  const { t } = useTranslation("serverWeb");
  const [config, setConfig] = useState<AuthConfig>();
  const [method, setMethod] = useState("password");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [cooldownEmail, setCooldownEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(message);
  const [notice, setNotice] = useState("");
  const [completed, setCompleted] = useState(false);
  const [configRequest, setConfigRequest] = useState(0);
  const [configLoading, setConfigLoading] = useState(true);
  const identifierRef = useRef<HTMLInputElement>(null);
  const requestPending = useRef(false);
  const register = mode === "register", reset = mode === "forgot-password";
  const emailMode = reset || method === "email";
  const returnTo = window.location.pathname === "/login/device"
    ? readLoginReturnTo(`?${new URLSearchParams({ returnTo: window.location.pathname + window.location.search })}`) ?? "/login/device"
    : readLoginReturnTo(window.location.search);
  const link = (path: string) => path + (returnTo ? `?${new URLSearchParams({ returnTo })}` : "");
  useEffect(() => { setError(message); }, [message]);
  useEffect(() => { let live = true; setConfigLoading(true); void apiClient.authAction<AuthConfig>("/config").then(result => {
    if (!live) return;
    setConfigLoading(false);
    if (isApiSuccess(result)) { setConfig(result.data); if (configRequest) setError(undefined); }
    else setError(result.errMessage || t("authConfigFailed"));
  }); return () => { live = false; }; }, [t, configRequest]);
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown(value => value - 1), 1000); return () => clearTimeout(timer); }, [cooldown]);
  function changeIdentifier(value: string) { setIdentifier(value); setChallengeId(""); setCode(""); setNotice(""); }
  async function sendCode() {
    if (requestPending.current || !identifierRef.current?.reportValidity()) return;
    requestPending.current = true;
    setSending(true); setError(undefined); setNotice("");
    const result = await apiClient.authAction<CodeChallenge>("/email-code/send", {
      email: identifier.trim(), purpose: reset ? "password-reset" : register ? "register" : "login",
    });
    requestPending.current = false; setSending(false);
    if (isApiSuccess(result)) { setChallengeId(result.data.challengeId); setCooldown(result.data.retryAfterSeconds); setCooldownEmail(identifier.trim().toLowerCase()); setNotice(t("authCodeSent")); }
    else setError(result.errMessage);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (requestPending.current || unavailable || completed || !event.currentTarget.reportValidity()) return;
    if ((register || reset) && password !== passwordConfirmation) { setError(t("accountInvitePasswordMismatch")); return; }
    requestPending.current = true;
    setBusy(true); setError(undefined); setNotice("");
    const path = reset ? "/password/reset" : register ? "/register" : emailMode ? "/email-code/login" : "/login";
    const payload = reset ? { challengeId, code, password } : register
      ? { method: emailMode ? "email" : "username", username: identifier.trim(), password, challengeId, code }
      : emailMode ? { challengeId, code } : { identifier: identifier.trim(), password };
    const result = await apiClient.authAction(path, payload);
    requestPending.current = false; setBusy(false);
    if (!isApiSuccess(result)) { setError(result.errMessage); return; }
    setPassword(""); setPasswordConfirmation(""); setCode("");
    if (reset) { setCompleted(true); setNotice(t("authPasswordResetComplete")); return; }
    if (returnTo) { window.location.assign(returnTo); return; }
    if (register) { window.location.assign("/settings/profile"); return; }
    onAuthenticated();
  }
  const unavailable = !config || (register && !config.registrationEnabled) || (emailMode && !config.mailAvailable);
  const resendCooldown = cooldownEmail === identifier.trim().toLowerCase() ? cooldown : 0;
  return <main className="flex min-h-svh flex-col items-center justify-center gap-8 p-6 md:p-10">
    <div className="flex items-center gap-2 font-medium"><img src="/brand/steamharness-icon.svg" alt="" className="size-6" />SteamHarness</div>
    <div className="w-full max-w-sm">
      <form onSubmit={submit} className="flex flex-col gap-6">
        <div className="flex flex-col gap-2 text-center"><h1 className="text-2xl font-bold">{t(reset ? "authResetTitle" : register ? "authRegisterTitle" : "loginCardTitle")}</h1>
          <p className="text-sm text-balance text-muted-foreground">{t(reset ? "authResetHelp" : register ? "authRegisterHelp" : "loginCardDescription")}</p></div>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
        {!config ? <Button type="button" variant="outline" disabled={configLoading} onClick={() => setConfigRequest(value => value + 1)}>
          {configLoading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}{t(configLoading ? "appCheckingSession" : "commonRetry")}</Button> : null}
        {completed ? null : register && config && !config.registrationEnabled ? <Alert><AlertDescription>{t("authRegistrationClosed")}</AlertDescription></Alert> : <>
          {!reset ? <ToggleGroup type="single" variant="outline" value={method} aria-label={t("authMethod")} disabled={busy || sending}
            onValueChange={value => { if (value) { setMethod(value); changeIdentifier(""); setPassword(""); setPasswordConfirmation(""); setError(undefined); } }}>
            <ToggleGroupItem value="password">{t(register ? "authUsernameRegistration" : "authPasswordLogin")}</ToggleGroupItem>
            <ToggleGroupItem value="email" disabled={!config?.mailAvailable}>{t(register ? "authEmailRegistration" : "authEmailCodeLogin")}</ToggleGroupItem>
          </ToggleGroup> : null}
          {emailMode && config && !config.mailAvailable ? <Alert><AlertDescription>{t("authMailUnavailable")}</AlertDescription></Alert> : null}
          <FieldGroup>
            <Field><FieldLabel htmlFor="login-identifier">{t(emailMode ? "loginEmailLabel" : register ? "authUsername" : "authIdentifier")}</FieldLabel>
              <Input ref={identifierRef} id="login-identifier" type={emailMode ? "email" : "text"} value={identifier} onChange={event => changeIdentifier(event.target.value)}
                autoComplete="username" autoFocus required minLength={register && !emailMode ? 3 : undefined} pattern={register && !emailMode ? "[A-Za-z0-9][A-Za-z0-9_\\-]{2,31}" : undefined}
                maxLength={emailMode ? 254 : register ? 32 : 254} disabled={busy || sending || configLoading} />
              {register && !emailMode ? <FieldDescription>{t("authUsernameHelp")}</FieldDescription> : null}</Field>
            {emailMode ? <Field><FieldLabel htmlFor="login-code">{t("authVerificationCode")}</FieldLabel>
              <div className="flex gap-2"><Input id="login-code" value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required disabled={busy} />
                <Button type="button" variant="outline" onClick={() => void sendCode()} disabled={busy || sending || resendCooldown > 0 || !identifier.trim() || !config?.mailAvailable}>
                  {sending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}{resendCooldown ? t("authResendCountdown", { seconds: resendCooldown }) : t("authSendCode")}</Button></div></Field> : null}
            {(!emailMode || register || reset) ? <Field><FieldLabel htmlFor="login-password">{t(emailMode && register ? "authOptionalPassword" : "loginPasswordLabel")}</FieldLabel>
              <Input id="login-password" type="password" value={password} onChange={event => { setPassword(event.target.value); if (!event.target.value) setPasswordConfirmation(""); }} autoComplete={register || reset ? "new-password" : "current-password"}
                minLength={register || reset ? 8 : undefined} maxLength={4096} required={!emailMode || reset} disabled={busy} /></Field> : null}
            {(register || reset) && password ? <Field data-invalid={!!passwordConfirmation && password !== passwordConfirmation}>
              <FieldLabel htmlFor="login-password-confirmation">{t("accountInviteConfirmPasswordLabel")}</FieldLabel>
              <Input id="login-password-confirmation" type="password" autoComplete="new-password" required minLength={8} maxLength={4096}
                value={passwordConfirmation} onChange={event => setPasswordConfirmation(event.target.value)} aria-invalid={!!passwordConfirmation && password !== passwordConfirmation} disabled={busy} />
            </Field> : null}
            <Field><Button type="submit" disabled={busy || sending || unavailable || (emailMode && !challengeId)}>
              {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}{t(reset ? "authResetAction" : register ? "authRegisterAction" : "loginEnterConsole")}</Button></Field>
          </FieldGroup>
        </>}
        <nav className="flex flex-wrap justify-center gap-4 text-sm" aria-label={t("authNavigation")}>
          {mode !== "login" ? <a className="underline underline-offset-4" href={link("/login")}>{t("authBackToLogin")}</a> : null}
          {!register && config?.registrationEnabled ? <a className="underline underline-offset-4" href={link("/register")}>{t("authRegisterAction")}</a> : null}
          {!reset ? <a className="underline underline-offset-4" href={link("/forgot-password")}>{t("authForgotPassword")}</a> : null}
        </nav>
      </form>
    </div>
  </main>;
}
