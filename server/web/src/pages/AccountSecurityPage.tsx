import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { CircleAlertIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react";
import { apiClient } from "../api";
import { isApiSuccess } from "../types";
import { type AuthConfig } from "../components/LoginPage";
import { AccountSecurityAction, useEmailCodeCooldowns, type AccountSecurity } from "../components/AccountSecurityAction";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

function AccountSecurityLoading() {
  const { t } = useTranslation("serverWeb");
  return <div role="status" aria-label={t("busyLoadAccount")} aria-busy="true">
    <span className="sr-only">{t("busyLoadAccount")}</span>
    <div aria-hidden="true" className="flex flex-col gap-6">
      {([
        ["loginEmailLabel", "authEmailSecurityHelp"],
        ["loginPasswordLabel", "authPasswordSecurityHelp"],
        ["authUsername", "authUsernameHelp"],
      ] as const).map(([title, description], index) => <Card key={title}>
        <CardHeader><CardTitle>{t(title)}</CardTitle><CardDescription>{t(description)}</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Skeleton className="h-5 w-48 max-w-full" />
          {index === 0 ? <Skeleton className="h-4 w-24" /> : null}
        </CardContent>
        <CardFooter><Skeleton className="h-9 w-24" /></CardFooter>
      </Card>)}
    </div>
  </div>;
}

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

  const header = <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold">{t("authSecurityTitle")}</h1><p className="text-sm text-muted-foreground">{t("authSecurityHelp")}</p></div>;

  if (!security) return <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
    {header}
    {loading ? <AccountSecurityLoading /> : <Card>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">{needsSignIn ? <KeyRoundIcon /> : <CircleAlertIcon />}</EmptyMedia>
          <EmptyTitle>{t(needsSignIn ? "authBackToLogin" : "appLayoutToastError")}</EmptyTitle>
          <EmptyDescription role={needsSignIn ? "status" : "alert"}>{error}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {needsSignIn ? <>
            <p>{t("authSecurityBrowserLogin")}</p>
            {onSignIn ? <Button onClick={onSignIn}>{t("authBackToLogin")}</Button> : null}
          </> : <Button variant="outline" onClick={() => void load()}><RefreshCwIcon data-icon="inline-start" />{t("commonRetry")}</Button>}
        </EmptyContent>
      </Empty>
    </Card>}
  </div>;

  const actionProps = { security, mail, cooldowns, onComplete: complete, disabled: loading };
  return <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
    {header}
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription><Button variant="outline" disabled={loading} onClick={() => void load()}>{t("commonRefresh")}</Button></Alert> : null}
    {notice ? <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert> : null}
    {!mail ? <Alert><AlertDescription>{t("authMailUnavailable")}</AlertDescription></Alert> : null}
    <Card>
      <CardHeader><CardTitle>{t("loginEmailLabel")}</CardTitle><CardDescription>{t("authEmailSecurityHelp")}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="break-all text-sm">{security.email || t("authNotBound")}</p>
        {security.email ? <p className="text-sm text-muted-foreground">{t(security.emailVerifiedAt ? "authEmailVerified" : "authEmailUnverified")}</p> : null}
        {!security.emailVerifiedAt ? <p className="text-sm text-muted-foreground">{t("authRecoveryHelp")}</p> : null}
        {security.email && (!security.username || !security.hasPassword) ? <p className="text-sm text-muted-foreground">{t("authUnbindRequirements")}</p> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {!security.email ? <AccountSecurityAction {...actionProps} action="bind-email" disabled={loading || !mail} /> : <>
          {!security.emailVerifiedAt ? <AccountSecurityAction {...actionProps} action="verify-email" disabled={loading || !mail} /> : null}
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
