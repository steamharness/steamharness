import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import { isApiSuccess } from "../types";
import { type AuthConfig } from "../components/LoginPage";
import { AccountSecurityAction, useEmailCodeCooldowns, type AccountSecurity } from "../components/AccountSecurityAction";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export function AccountSecurityPage({ onChanged, onSignIn }: {
  onChanged: (signInRequired?: boolean) => void | Promise<void>;
  onSignIn?: () => void;
}) {
  const { t } = useTranslation("serverWeb");
  const [security, setSecurity] = useState<AccountSecurity>();
  const [mail, setMail] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const cooldowns = useEmailCodeCooldowns();

  async function load() {
    const request = ++generation.current;
    setLoading(true); setError(""); setNeedsSignIn(false);
    const [result, config] = await Promise.all([
      apiClient.authAction<AccountSecurity>("/me/security"), apiClient.authAction<AuthConfig>("/config"),
    ]);
    if (request !== generation.current) return;
    setLoading(false);
    if (!isApiSuccess(result)) {
      setSecurity(undefined); setNeedsSignIn(result.errCode === 401); setError(result.errMessage); return;
    }
    setSecurity(result.data);
    setMail(isApiSuccess(config) && config.data.mailAvailable);
    if (!isApiSuccess(config)) setError(config.errMessage || t("authConfigFailed"));
  }
  useEffect(() => { void load(); return () => { ++generation.current; }; }, []);

  async function complete(signInRequired: boolean) {
    if (signInRequired) {
      ++generation.current;
      setSecurity(undefined); setNeedsSignIn(true); setError(t("authSecuritySignInAgain"));
    } else {
      await load(); setNotice(t("authSecuritySaved"));
    }
    await onChanged(signInRequired);
  }

  if (!security) return <div className="p-6">
    <Alert><AlertDescription>{error || t("appCheckingSession")}</AlertDescription></Alert>
    {needsSignIn ? onSignIn ? <><p className="py-4 text-sm">{t("authSecurityBrowserLogin")}</p><Button onClick={onSignIn}>{t("authBackToLogin")}</Button></> : null
      : <Button variant="outline" disabled={loading} onClick={() => void load()}>{t("commonRetry")}</Button>}
  </div>;

  const canProve = security.hasPassword || !!(security.emailVerifiedAt && mail);
  const actionProps = { security, mail, cooldowns, onComplete: complete, disabled: loading || !canProve };
  return <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
    <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold">{t("authSecurityTitle")}</h1><p className="text-sm text-muted-foreground">{t("authSecurityHelp")}</p></div>
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription><Button variant="outline" disabled={loading} onClick={() => void load()}>{t("commonRefresh")}</Button></Alert> : null}
    {notice ? <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert> : null}
    {!mail ? <Alert><AlertDescription>{t("authMailUnavailable")}</AlertDescription></Alert> : null}
    {!canProve ? <Alert><AlertDescription>{t("authSecurityProofUnavailable")}</AlertDescription></Alert> : null}
    <Card>
      <CardHeader><CardTitle>{t("loginEmailLabel")}</CardTitle><CardDescription>{t("authEmailSecurityHelp")}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="break-all text-sm">{security.email || t("authNotBound")}</p>
        {security.email ? <p className="text-sm text-muted-foreground">{t(security.emailVerifiedAt ? "authEmailVerified" : "authEmailUnverified")}</p> : null}
        {!security.emailVerifiedAt ? <p className="text-sm text-muted-foreground">{t("authRecoveryHelp")}</p> : null}
        {security.email && (!security.username || !security.hasPassword) ? <p className="text-sm text-muted-foreground">{t("authUnbindRequirements")}</p> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {!security.email ? <AccountSecurityAction {...actionProps} action="bind-email" disabled={actionProps.disabled || !mail} /> : <>
          {!security.emailVerifiedAt ? <AccountSecurityAction {...actionProps} action="verify-email" disabled={actionProps.disabled || !mail} /> : null}
          <AccountSecurityAction {...actionProps} action="change-email" disabled={actionProps.disabled || !mail} />
          <AccountSecurityAction {...actionProps} action="unbind-email" disabled={actionProps.disabled || !security.username || !security.hasPassword} />
        </>}
      </CardFooter>
    </Card>
    <Card>
      <CardHeader><CardTitle>{t("loginPasswordLabel")}</CardTitle><CardDescription>{t("authPasswordSecurityHelp")}</CardDescription></CardHeader>
      <CardContent><p className="text-sm">{t(security.hasPassword ? "authPasswordSet" : "authNotSet")}</p></CardContent>
      <CardFooter><AccountSecurityAction {...actionProps} action="password" /></CardFooter>
    </Card>
    <Card>
      <CardHeader><CardTitle>{t("authUsername")}</CardTitle><CardDescription>{t("authUsernameHelp")}</CardDescription></CardHeader>
      <CardContent><p className="break-all text-sm">{security.username || t("authNotSet")}</p></CardContent>
      {!security.username ? <CardFooter><AccountSecurityAction {...actionProps} action="username" /></CardFooter> : null}
    </Card>
  </div>;
}
