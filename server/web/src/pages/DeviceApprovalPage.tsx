import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface DeviceApprovalPageProps {
  userCode: string;
  statusMessage?: string;
  busy?: string;
  disabled?: boolean;
  onUserCodeChange: (value: string) => void;
  onApprove: () => void;
  onDeny: () => void;
}

export function DeviceApprovalPage({
  userCode,
  statusMessage,
  busy,
  disabled,
  onUserCodeChange,
  onApprove,
  onDeny,
}: DeviceApprovalPageProps) {
  const { t } = useTranslation("serverWeb");
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle role="heading" aria-level={1}>{t("deviceTitle")}</CardTitle>
          <CardDescription>{t("deviceCardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="device-code">{t("deviceInputLabel")}</FieldLabel>
            <Input
              id="device-code"
              className="font-mono"
              value={userCode}
              onChange={(event) => onUserCodeChange(event.target.value.toUpperCase())}
              placeholder="ABCD-1234"
              disabled={disabled || !!busy}
              autoFocus
            />
            </Field>
          </FieldGroup>
          {statusMessage ? (
            <Alert><AlertDescription>{statusMessage}</AlertDescription></Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex items-center justify-end gap-3">
          <Button variant="outline" disabled={disabled || !!busy} onClick={onDeny}>
            {busy === "deny" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <XCircle data-icon="inline-start" />}
            {t("deviceDeny")}
          </Button>
          <Button disabled={disabled || !!busy || !userCode.trim()} onClick={onApprove}>
            {busy === "approve" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <CheckCircle2 data-icon="inline-start" />}
            {t("deviceApprove")}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
