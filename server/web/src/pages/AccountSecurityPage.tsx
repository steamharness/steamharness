import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import { isApiSuccess } from "../types";
import { type AuthConfig, type CodeChallenge } from "../components/LoginPage";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface Security { username: string | null; email: string | null; emailVerifiedAt: string | null; hasPassword: boolean }
export function AccountSecurityPage({ onChanged, onSignIn }: {
  onChanged: (signInRequired?: boolean) => void | Promise<void>;
  onSignIn?: () => void;
}) {
  const { t } = useTranslation("serverWeb");
  const [security, setSecurity] = useState<Security>();
  const [mail, setMail] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState("email");
  const [proofMethod, setProofMethod] = useState("password");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [reauth, setReauth] = useState("");
  const [reauthCode, setReauthCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [cooldowns, setCooldowns] = useState({ target: 0, proof: 0 });
  const [cooldownEmail, setCooldownEmail] = useState("");
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const generation = useRef(0);
  const requestPending = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);

  async function load() {
    const request = ++generation.current;
    setLoading(true); setError(""); setNeedsSignIn(false);
    clearProof(); setChallenge(""); setCode("");
    const [result, config] = await Promise.all([
      apiClient.authAction<Security>("/me/security"), apiClient.authAction<AuthConfig>("/config"),
    ]);
    if (request !== generation.current) return;
    setLoading(false);
    if (!isApiSuccess(result)) { setSecurity(undefined); setNeedsSignIn(result.errCode === 401); setError(result.errMessage); return; }
    setSecurity(result.data); setEmail(result.data.email || "");
    setProofMethod(result.data.hasPassword ? "password" : "email");
    if (result.data.username) setAction(value => value === "username" ? "email" : value);
    if (isApiSuccess(config)) setMail(config.data.mailAvailable);
    else { setMail(false); setError(config.errMessage || t("authConfigFailed")); }
  }
  useEffect(() => { void load(); return () => { ++generation.current; }; }, []);
  useEffect(() => {
    if (!cooldowns.target && !cooldowns.proof) return;
    const timer = setTimeout(() => setCooldowns(value => ({ target: Math.max(0, value.target - 1), proof: Math.max(0, value.proof - 1) })), 1000);
    return () => clearTimeout(timer);
  }, [cooldowns]);

  function clearProof() { setCurrentPassword(""); setReauth(""); setReauthCode(""); }
  async function send(target: boolean) {
    if (requestPending.current || !security || !mail || (target && !emailRef.current?.reportValidity())) return;
    requestPending.current = true;
    setBusy(true); setError(""); setNotice("");
    const request = generation.current;
    const result = await apiClient.authAction<CodeChallenge>("/email-code/send", {
      email: target ? email.trim() : security.email, purpose: target ? "bind-email" : "reauth",
    });
    requestPending.current = false;
    setBusy(false);
    if (request !== generation.current) return;
    if (!isApiSuccess(result)) { setError(result.errMessage); return; }
    if (target) { setChallenge(result.data.challengeId); setCooldownEmail(email.trim().toLowerCase()); }
    else setReauth(result.data.challengeId);
    setCooldowns(value => ({ ...value, [target ? "target" : "proof"]: result.data.retryAfterSeconds }));
    setNotice(t("authCodeSent"));
  }

  const hasProof = proofMethod === "password" ? !!currentPassword : !!reauth && /^\d{6}$/.test(reauthCode);
  const emailUnchanged = !!security?.emailVerifiedAt && email.trim().toLowerCase() === security.email;
  const targetCooldown = cooldownEmail === email.trim().toLowerCase() ? cooldowns.target : 0;
  async function save(unbind = false) {
    if (requestPending.current || !hasProof) return;
    if (action === "password" && password !== passwordConfirmation) { setError(t("accountInvitePasswordMismatch")); return; }
    requestPending.current = true;
    setBusy(true); setError(""); setNotice(""); setConfirmUnbind(false);
    const request = generation.current;
    const proof = proofMethod === "password" ? { currentPassword } : { reauthChallengeId: reauth, reauthCode };
    const result = await apiClient.authAction(`/me/${action}`, {
      ...proof, ...(action === "email" ? { action: unbind ? "unbind" : "bind", ...(unbind ? {} : { challengeId: challenge, code }) }
        : action === "username" ? { username } : { password }),
    });
    requestPending.current = false;
    setBusy(false);
    if (request !== generation.current) return;
    // A successful proof is single-use even when a later account update fails.
    if (proofMethod === "email") { setReauth(""); setReauthCode(""); }
    if (action === "email" && !unbind) { setChallenge(""); setCode(""); }
    if (!isApiSuccess(result)) {
      setError(result.errMessage);
      if (proofMethod === "email" || action === "email" && !unbind) setNotice(t("authFreshCodeRequired"));
      return;
    }
    setPassword(""); setPasswordConfirmation(""); clearProof();
    if (action === "password" || action === "email") { await onChanged(true); return; }
    setUsername(""); await load(); setNotice(t("authSecuritySaved")); await onChanged(false);
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (event.currentTarget.reportValidity()) void save();
  }

  if (!security) return <div className="p-6"><Alert><AlertDescription>{error || t("appCheckingSession")}</AlertDescription></Alert>
    {needsSignIn && onSignIn ? <><p className="py-4 text-sm">{t("authSecurityBrowserLogin")}</p><Button onClick={onSignIn}>{t("authBackToLogin")}</Button></>
      : <Button variant="outline" disabled={loading} onClick={() => void load()}>{t("commonRetry")}</Button>}</div>;
  return <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
    <Card><CardHeader><CardTitle><h1>{t("authSecurityTitle")}</h1></CardTitle><CardDescription>{t("authSecurityHelp")}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-2 text-sm">
          <div><dt className="inline">{t("authUsername")}: </dt><dd className="inline">{security.username || t("authNotSet")}</dd></div>
          <div><dt className="inline">{t("loginEmailLabel")}: </dt><dd className="inline">{security.email ? `${security.email} · ${t(security.emailVerifiedAt ? "authEmailVerified" : "authEmailUnverified")}` : t("authNotBound")}</dd></div>
          <div><dt className="inline">{t("loginPasswordLabel")}: </dt><dd className="inline">{t(security.hasPassword ? "authPasswordSet" : "authNotSet")}</dd></div>
        </dl>
        {!security.emailVerifiedAt ? <Alert><AlertDescription>{t("authRecoveryHelp")}</AlertDescription></Alert> : null}
        {!mail ? <Alert><AlertDescription>{t("authMailUnavailable")}</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription><Button type="button" variant="outline" disabled={busy || loading} onClick={() => void load()}>{t("commonRefresh")}</Button></Alert> : null}
        {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
        <ToggleGroup type="single" variant="outline" value={action} aria-label={t("authSecurityTitle")} disabled={busy || loading}
          onValueChange={value => { if (value) { setAction(value); setPassword(""); setPasswordConfirmation(""); clearProof(); setError(""); setNotice(""); } }}>
          <ToggleGroupItem value="email">{t("authBindEmail")}</ToggleGroupItem><ToggleGroupItem value="password">{t("authSetPassword")}</ToggleGroupItem>
          {!security.username ? <ToggleGroupItem value="username">{t("authSetUsername")}</ToggleGroupItem> : null}
        </ToggleGroup>
        <form onSubmit={submit}><FieldGroup>
          {action === "username" ? <Field><FieldLabel htmlFor="security-username">{t("authUsername")}</FieldLabel>
            <Input id="security-username" required minLength={3} maxLength={32} pattern={"[A-Za-z0-9][A-Za-z0-9_\\-]{2,31}"} value={username} onChange={event => setUsername(event.target.value)} disabled={busy || loading} />
            <FieldDescription>{t("authUsernameHelp")}</FieldDescription></Field> : null}
          {action === "password" ? <>
            <Field><FieldLabel htmlFor="security-password">{t("authNewPassword")}</FieldLabel><Input id="security-password" type="password" required minLength={8} maxLength={4096} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy || loading} /><FieldDescription>{t("authPasswordRevokeHelp")}</FieldDescription></Field>
            <Field data-invalid={!!passwordConfirmation && password !== passwordConfirmation}><FieldLabel htmlFor="security-password-confirmation">{t("accountInviteConfirmPasswordLabel")}</FieldLabel>
              <Input id="security-password-confirmation" type="password" required minLength={8} maxLength={4096} autoComplete="new-password" value={passwordConfirmation} onChange={event => setPasswordConfirmation(event.target.value)} aria-invalid={!!passwordConfirmation && password !== passwordConfirmation} disabled={busy || loading} /></Field>
          </> : null}
          {action === "email" ? <>
            <Field><FieldLabel htmlFor="security-email">{t("loginEmailLabel")}</FieldLabel><Input ref={emailRef} id="security-email" type="email" required maxLength={254} autoComplete="email" value={email} onChange={event => { setEmail(event.target.value); setChallenge(""); setCode(""); setNotice(""); }} disabled={busy || loading} />
              <FieldDescription>{t(emailUnchanged ? "authEmailAlreadyVerified" : "authEmailRevokeHelp")}</FieldDescription></Field>
            <Field><FieldLabel htmlFor="security-code">{t("authVerificationCode")}</FieldLabel><div className="flex gap-2"><Input id="security-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required value={code} onChange={event => setCode(event.target.value)} disabled={busy || loading || emailUnchanged} />
              <Button type="button" variant="outline" disabled={busy || loading || !mail || emailUnchanged || targetCooldown > 0 || !email.trim()} onClick={() => void send(true)}>{targetCooldown ? t("authResendCountdown", { seconds: targetCooldown }) : t("authSendCode")}</Button></div></Field>
          </> : null}
          <Field><FieldDescription>{t("authProofHelp")}</FieldDescription>
            {security.hasPassword && security.emailVerifiedAt && mail ? <ToggleGroup type="single" variant="outline" value={proofMethod} aria-label={t("authProofMethod")} disabled={busy || loading}
              onValueChange={value => { if (value) { setProofMethod(value); clearProof(); } }}>
              <ToggleGroupItem value="password">{t("authCurrentPassword")}</ToggleGroupItem><ToggleGroupItem value="email">{t("authBoundEmailCode")}</ToggleGroupItem>
            </ToggleGroup> : null}
            {proofMethod === "password" ? <><FieldLabel htmlFor="security-current-password">{t("authCurrentPassword")}</FieldLabel><Input id="security-current-password" type="password" autoComplete="current-password" maxLength={4096} required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={busy || loading} /></> : <>
              <FieldLabel htmlFor="security-proof-code">{t("authBoundEmailCode")}</FieldLabel><FieldDescription>{security.email}</FieldDescription><div className="flex gap-2"><Input id="security-proof-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required value={reauthCode} onChange={event => setReauthCode(event.target.value)} disabled={busy || loading || !mail} />
                <Button type="button" variant="outline" aria-label={t("authSendBoundEmailCode")} disabled={busy || loading || !mail || cooldowns.proof > 0} onClick={() => void send(false)}>{cooldowns.proof ? t("authResendCountdown", { seconds: cooldowns.proof }) : t("authSendCode")}</Button></div>
            </>}
          </Field>
          <Field><Button type="submit" disabled={busy || loading || !hasProof || (action === "email" && (!mail || !challenge || emailUnchanged))}>{t("authSecuritySave")}</Button>
            {action === "email" && security.email && security.username && security.hasPassword ? <Button type="button" variant="destructive" disabled={busy || loading || !hasProof} onClick={() => setConfirmUnbind(true)}>{t("authUnbindEmail")}</Button> : null}
          </Field>
        </FieldGroup></form>
      </CardContent></Card>
    <ConfirmActionDialog action={confirmUnbind ? {title:t("authUnbindEmail"),description:t("authUnbindConfirm"),confirmLabel:t("authUnbindEmail"),onConfirm:() => void save(true)} : null} onOpenChange={open => setConfirmUnbind(open)} />
  </div>;
}
