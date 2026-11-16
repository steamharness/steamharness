import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import { isApiSuccess } from "../types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface DeviceInfo { clientName: string; context?: { channel: string }; state: string; expiresAt: string; returnUrl?: string }
function safeReturnUrl(value: string | undefined): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.searchParams.size !== 1) return;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("auth_state") || "")) return url.href;
    if (["steamharness-studio-dev:", "steamharness-studio-alpha:", "steamharness-studio:"].includes(url.protocol) && url.host === "studio.studio-workstation" && url.pathname === "/auth/callback" && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") || "")) return url.href;
  } catch { /* An invalid return link must not prevent manual return to the app. */ }
}
export function DeviceApprovalPage({ userCode: initialCode, identity, onSwitchAccount }: { userCode: string; identity: string; onSwitchAccount: (userCode: string) => void }) {
  const { t } = useTranslation("serverWeb");
  const [code, setCode] = useState(initialCode.trim().toUpperCase());
  const [info, setInfo] = useState<DeviceInfo>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const requestPending = useRef(false);
  const generation = useRef(0);
  const latestCode = useRef(code);
  latestCode.current = code;
  const validCode = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
  useEffect(() => { setCode(initialCode.trim().toUpperCase()); }, [initialCode]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const request = ++generation.current;
    setInfo(undefined); setError(""); setLoading(validCode);
    if (validCode) void apiClient.authAction<DeviceInfo>(`/device/${encodeURIComponent(code)}`).then(result => {
      if (request !== generation.current) return;
      setLoading(false);
      if (isApiSuccess(result)) setInfo(result.data); else setError(result.errMessage);
    });
    return () => { ++generation.current; };
  }, [code, refresh, validCode]);
  const expired = info && (info.state === "expired" || info.state !== "consumed" && (!Number.isFinite(Date.parse(info.expiresAt)) || Date.parse(info.expiresAt) <= now));
  const approved = info && !expired && ["approved", "consumed"].includes(info.state);
  const returnUrl = approved ? safeReturnUrl(info.returnUrl) : undefined;
  const disabled = !info || expired || info.state !== "pending" || busy || loading;
  async function act(approve: boolean) {
    if (requestPending.current || disabled) return;
    requestPending.current = true;
    setBusy(true); setError("");
    const request = generation.current;
    const result = await apiClient.authAction<{ returnUrl?: string }>(approve ? "/device/approve" : "/device/deny", { userCode: code });
    requestPending.current = false;
    setBusy(false);
    if (request !== generation.current) return;
    if (isApiSuccess(result)) setInfo(value => value && ({ ...value, state: approve ? "approved" : "denied", returnUrl: result.data.returnUrl }));
    else if (result.errCode === 409) setRefresh(value => value + 1);
    else setError(result.errMessage);
  }
  async function switchAccount() {
    if (requestPending.current) return;
    requestPending.current = true;
    setBusy(true); setError("");
    const result = await apiClient.logout();
    requestPending.current = false;
    setBusy(false);
    if (isApiSuccess(result)) onSwitchAccount(latestCode.current);
    else setError(result.errMessage);
  }
  return <main className="flex min-h-svh items-center justify-center p-6"><Card className="w-full max-w-md">
    <CardHeader><CardTitle><h1>{t("deviceTitle")}</h1></CardTitle><CardDescription>{t("deviceCardDescription")}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-4">
      <Field><FieldLabel htmlFor="device-code">{t("deviceInputLabel")}</FieldLabel><Input id="device-code" className="font-mono" maxLength={9} value={code} onChange={event => setCode(event.target.value.trim().toUpperCase())} disabled={busy} />
        <FieldDescription>{t("authDeviceCodeHelp")}</FieldDescription></Field>
      <p className="break-words text-sm">{t("authDeviceIdentity", { identity })}</p><Button variant="outline" disabled={busy} onClick={() => void switchAccount()}>{t("authSwitchAccount")}</Button>
      {loading ? <p role="status">{t("authDeviceLoading")}</p> : null}
      {info ? <p className="text-sm">{info.clientName} · {info.context?.channel || "CLI"}</p> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription><Button variant="outline" disabled={busy || loading || !validCode} onClick={() => setRefresh(value => value + 1)}>{t("commonRetry")}</Button></Alert> : null}
      {expired || approved || info?.state === "denied" ? <Alert><AlertDescription>{t(approved ? "deviceStatusApproved" : expired ? "authDeviceExpired" : "authDeviceDenied")}</AlertDescription></Alert> : null}
      {returnUrl ? <Button asChild><a href={returnUrl}>{t("authReturnApp")}</a></Button> : null}
    </CardContent>
    <CardFooter className="justify-end gap-3"><Button variant="outline" disabled={!!disabled} onClick={() => void act(false)}>{t("deviceDeny")}</Button><Button disabled={!!disabled} onClick={() => void act(true)}>{t("deviceApprove")}</Button></CardFooter>
  </Card></main>;
}
