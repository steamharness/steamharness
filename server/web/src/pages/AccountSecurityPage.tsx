import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import { isApiSuccess } from "../types";
import { type AuthConfig, type CodeChallenge } from "../components/LoginPage";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
interface Security { username: string | null; email: string | null; emailVerifiedAt: string | null; hasPassword: boolean }
export function AccountSecurityPage({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation("serverWeb");
  const [security, setSecurity] = useState<Security>();
  const [mail, setMail] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState("email");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [reauth, setReauth] = useState("");
  const [reauthCode, setReauthCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [cooldowns, setCooldowns] = useState({ target: 0, proof: 0 });
  async function load() {
    const result = await apiClient.authAction<Security>("/me/security");
    if (isApiSuccess(result)) { setSecurity(result.data); setEmail(result.data.email || ""); } else setError(result.errMessage);
  }
  useEffect(() => { void load(); void apiClient.authAction<AuthConfig>("/config").then(result => { if (isApiSuccess(result)) setMail(result.data.mailAvailable); }); }, []);
  useEffect(() => {
    if (!cooldowns.target && !cooldowns.proof) return;
    const timer = setTimeout(() => setCooldowns(value => ({ target: Math.max(0, value.target - 1), proof: Math.max(0, value.proof - 1) })), 1000);
    return () => clearTimeout(timer);
  }, [cooldowns]);
  async function send(target: boolean) {
    setBusy(true); setError(""); setNotice("");
    const result = await apiClient.authAction<CodeChallenge>("/email-code/send", { email: target ? email : security?.email, purpose: target ? "bind-email" : "reauth" });
    setBusy(false);
    if (!isApiSuccess(result)) { setError(result.errMessage); return; }
    if (target) setChallenge(result.data.challengeId); else setReauth(result.data.challengeId);
    setCooldowns(value => ({ ...value, [target ? "target" : "proof"]: result.data.retryAfterSeconds }));
    setNotice(t("authCodeSent"));
  }
  async function save(event: FormEvent, unbind = false) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setNotice("");
    const proof = { currentPassword, reauthChallengeId: reauth, reauthCode };
    const result = await apiClient.authAction(`/me/${action}`, { ...proof, ...(action === "email" ? { action: unbind ? "unbind" : "bind", challengeId: challenge, code } : action === "username" ? { username } : { password }) });
    setBusy(false);
    if (!isApiSuccess(result)) { setError(result.errMessage); return; }
    setPassword(""); setCurrentPassword(""); setCode(""); setChallenge(""); setReauth(""); setReauthCode("");
    if (action === "password" || action === "email") { onChanged(); return; }
    setNotice(t("authSecuritySaved")); await load(); onChanged();
  }
  if (!security) return <div className="p-6"><Alert><AlertDescription>{error || t("appCheckingSession")}</AlertDescription></Alert><Button variant="outline" onClick={() => void load()}>{t("commonRefresh")}</Button></div>;
  return <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
    <Card><CardHeader><CardTitle><h1>{t("authSecurityTitle")}</h1></CardTitle><CardDescription>{t("authSecurityHelp")}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4"><dl className="grid gap-2 text-sm"><div>{t("authUsername")}: {security.username || t("authNotSet")}</div>
        <div>{t("loginEmailLabel")}: {security.email ? `${security.email} · ${t(security.emailVerifiedAt ? "authEmailVerified" : "authEmailUnverified")}` : t("authNotBound")}</div>
        <div>{t("loginPasswordLabel")}: {t(security.hasPassword ? "authPasswordSet" : "authNotSet")}</div></dl>
        {!security.emailVerifiedAt ? <Alert><AlertDescription>{t("authRecoveryHelp")}</AlertDescription></Alert> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
        <ToggleGroup type="single" variant="outline" value={action} aria-label={t("authSecurityTitle")} disabled={busy} onValueChange={value => { if (value) { setAction(value); setError(""); setNotice(""); } }}>
          <ToggleGroupItem value="email">{t("authBindEmail")}</ToggleGroupItem><ToggleGroupItem value="password">{t("authSetPassword")}</ToggleGroupItem>
          {!security.username ? <ToggleGroupItem value="username">{t("authSetUsername")}</ToggleGroupItem> : null}
        </ToggleGroup>
        <form onSubmit={save}><FieldGroup>
          {action === "username" ? <Field><FieldLabel htmlFor="security-username">{t("authUsername")}</FieldLabel><Input id="security-username" required minLength={3} maxLength={32} value={username} onChange={event => setUsername(event.target.value)} disabled={busy} /><FieldDescription>{t("authUsernameHelp")}</FieldDescription></Field> : null}
          {action === "password" ? <Field><FieldLabel htmlFor="security-password">{t("authNewPassword")}</FieldLabel><Input id="security-password" type="password" required minLength={8} maxLength={4096} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /><FieldDescription>{t("authPasswordRevokeHelp")}</FieldDescription></Field> : null}
          {action === "email" ? <><Field><FieldLabel htmlFor="security-email">{t("loginEmailLabel")}</FieldLabel><Input id="security-email" type="email" required maxLength={254} value={email} onChange={event => { setEmail(event.target.value); setChallenge(""); setCode(""); }} disabled={busy} /></Field>
            <Field><FieldLabel htmlFor="security-code">{t("authVerificationCode")}</FieldLabel><div className="flex gap-2"><Input id="security-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value)} disabled={busy} />
              <Button type="button" variant="outline" disabled={busy || !mail || cooldowns.target > 0 || !email} onClick={() => void send(true)}>{cooldowns.target ? t("authResendCountdown", { seconds: cooldowns.target }) : t("authSendCode")}</Button></div></Field></> : null}
          <Field><FieldDescription>{t("authProofHelp")}</FieldDescription>
            {security.hasPassword ? <><FieldLabel htmlFor="security-current-password">{t("authCurrentPassword")}</FieldLabel><Input id="security-current-password" type="password" autoComplete="current-password" maxLength={4096} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={busy} /></> : null}
            {security.emailVerifiedAt ? <><FieldLabel htmlFor="security-proof-code">{t("authBoundEmailCode")}</FieldLabel><div className="flex gap-2"><Input id="security-proof-code" inputMode="numeric" maxLength={6} value={reauthCode} onChange={event => setReauthCode(event.target.value)} disabled={busy} />
              <Button type="button" variant="outline" disabled={busy || !mail || cooldowns.proof > 0} onClick={() => void send(false)}>{cooldowns.proof ? t("authResendCountdown", { seconds: cooldowns.proof }) : t("authSendCode")}</Button></div></> : null}
          </Field>
          <Field><Button type="submit" disabled={busy || (action === "email" && (!mail || !challenge))}>{t("authSecuritySave")}</Button>
            {action === "email" && security.email && security.username && security.hasPassword ? <Button type="button" variant="destructive" disabled={busy} onClick={event => { if (window.confirm(t("authUnbindConfirm"))) void save(event, true); }}>{t("authUnbindEmail")}</Button> : null}
          </Field>
        </FieldGroup></form>
      </CardContent></Card>
  </div>;
}
