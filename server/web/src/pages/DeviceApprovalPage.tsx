import { useEffect, useState } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import { isApiSuccess } from "../types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
interface DeviceInfo { clientName: string; context?: { channel: string }; state: string; expiresAt: string; returnUrl?: string }
export function DeviceApprovalPage({ userCode: initialCode, identity, onSwitchAccount }: { userCode: string; identity: string; onSwitchAccount: () => void }) {
  const { t } = useTranslation("serverWeb");
  const [code, setCode] = useState(initialCode);
  const [info, setInfo] = useState<DeviceInfo>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    let live = true; setInfo(undefined); setError("");
    if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) void apiClient.authAction<DeviceInfo>(`/device/${encodeURIComponent(code)}`).then(result => {
      if (!live) return;
      if (isApiSuccess(result)) setInfo(result.data); else setError(result.errMessage);
    });
    return () => { live = false; };
  }, [code]);
  async function act(approve: boolean) {
    setBusy(true); setError("");
    const result = await apiClient.authAction<{ returnUrl?: string }>(approve ? "/device/approve" : "/device/deny", { userCode: code });
    setBusy(false);
    if (isApiSuccess(result)) setInfo(value => value && ({ ...value, state: approve ? "approved" : "denied", returnUrl: result.data.returnUrl }));
    else setError(result.errMessage);
  }
  const expired = info && Date.parse(info.expiresAt) <= now;
  const approved = info && ["approved", "consumed"].includes(info.state);
  const disabled = !info || expired || info.state !== "pending" || busy;
  return <main className="flex min-h-svh items-center justify-center p-6"><Card className="w-full max-w-md">
    <CardHeader><CardTitle><h1>{t("deviceTitle")}</h1></CardTitle><CardDescription>{t("deviceCardDescription")}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-4"><Field><FieldLabel htmlFor="device-code">{t("deviceInputLabel")}</FieldLabel><Input id="device-code" className="font-mono" maxLength={9} value={code} onChange={event => setCode(event.target.value.toUpperCase())} disabled={busy} /></Field>
      <p className="break-words text-sm">{t("authDeviceIdentity", { identity })}</p><Button variant="outline" disabled={busy} onClick={onSwitchAccount}>{t("authSwitchAccount")}</Button>
      {info ? <p className="text-sm">{info.clientName} · {info.context?.channel || "CLI"}</p> : null}
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      {expired || approved || info?.state === "denied" ? <Alert><AlertDescription>{t(approved ? "deviceStatusApproved" : expired ? "authDeviceExpired" : "authDeviceDenied")}</AlertDescription></Alert> : null}
      {approved && info.returnUrl ? <Button asChild><a href={info.returnUrl}>{t("authReturnApp")}</a></Button> : null}
    </CardContent>
    <CardFooter className="justify-end gap-3"><Button variant="outline" disabled={!!disabled} onClick={() => void act(false)}>{t("deviceDeny")}</Button><Button disabled={!!disabled} onClick={() => void act(true)}>{t("deviceApprove")}</Button></CardFooter>
  </Card></main>;
}
