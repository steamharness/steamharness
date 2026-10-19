import { type FormEvent, useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { formatDateTime, useTranslation } from "@steamharness/i18n/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiClient } from "../api";
import { isApiSuccess, type AccountInvitation } from "../types";

interface AccountInvitePageProps {
  token: string;
  onContinue: () => void;
}

type AccountInviteState =
  | { phase: "loading" }
  | { phase: "ready"; invitation: AccountInvitation }
  | { phase: "success" }
  | { phase: "error"; message: string; retryable: boolean };

export function AccountInvitePage({ token, onContinue }: AccountInvitePageProps) {
  const { t } = useTranslation("serverWeb");
  const [state, setState] = useState<AccountInviteState>({ phase: "loading" });
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiClient.lookupAccountInvitation(token).then((response) => {
      if (cancelled) return;
      if (!isApiSuccess(response)) {
        setState({
          phase: "error",
          message: response.errMessage || t("accountInviteInvalidDescription"),
          retryable: response.errCode >= 500 || response.errCode < 0,
        });
        return;
      }
      if (response.data.invitation.acceptedAt) {
        setState({ phase: "error", message: t("accountInviteAcceptedDescription"), retryable: false });
        return;
      }
      if (Date.parse(response.data.invitation.expiresAt) <= Date.now()) {
        setState({ phase: "error", message: t("accountInviteExpiredDescription"), retryable: false });
        return;
      }
      setDisplayName(response.data.invitation.displayName);
      setState({ phase: "ready", invitation: response.data.invitation });
    });
    return () => {
      cancelled = true;
    };
  }, [t, token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.phase !== "ready" || submitting) return;
    if (password !== passwordConfirmation) {
      setState({ phase: "error", message: t("accountInvitePasswordMismatch"), retryable: true });
      return;
    }
    setSubmitting(true);
    const response = await apiClient.acceptAccountInvitation(token, {
      password,
      displayName: displayName.trim() || undefined,
    });
    setSubmitting(false);
    if (!isApiSuccess(response)) {
      setState({
        phase: "error",
        message: response.errMessage || t("inviteAcceptFailed"),
        retryable: response.errCode === 400 || response.errCode >= 500 || response.errCode < 0,
      });
      return;
    }
    setState({ phase: "success" });
  }

  if (state.phase === "loading") {
    return (
      <CenteredCard>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          {t("accountInviteReading")}
        </CardContent>
      </CenteredCard>
    );
  }

  if (state.phase === "success") {
    return (
      <CenteredCard>
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <CheckCircle2 className="size-9 text-foreground" />
          <div className="flex flex-col gap-1">
            <div className="text-lg font-semibold text-foreground">{t("accountInviteSuccessTitle")}</div>
            <p className="text-sm text-muted-foreground">{t("accountInviteSuccessDescription")}</p>
          </div>
          <Button onClick={onContinue}>{t("loginEnterConsole")}</Button>
        </CardContent>
      </CenteredCard>
    );
  }

  if (state.phase === "error") {
    return (
      <CenteredCard>
        <CardHeader>
          <CardTitle className="text-base">{t("inviteErrorTitleUnable")}</CardTitle>
          <CardDescription>{state.message}</CardDescription>
        </CardHeader>
        {state.retryable ? (
          <CardContent>
            <Button variant="outline" onClick={() => window.location.reload()}>{t("commonRetry")}</Button>
          </CardContent>
        ) : null}
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <CardHeader className="flex flex-col gap-4">
        <div className="inline-flex size-11 items-center justify-center rounded-lg border border-border bg-muted/50 text-primary">
          <KeyRound className="size-5" />
        </div>
        <div className="flex flex-col gap-2">
          <CardTitle className="text-xl">{t("accountInviteTitle")}</CardTitle>
          <CardDescription>{t("accountInviteDescription", { email: state.invitation.email })}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-5" onSubmit={(event) => void submit(event)}>
          <Alert>
            <AlertTitle>{state.invitation.email}</AlertTitle>
            <AlertDescription>{t("accountInviteExpiresAt", { expiresAt: formatDateTime(state.invitation.expiresAt) })}</AlertDescription>
          </Alert>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="account-invite-display-name">{t("usersEditDisplayNameLabel")}</FieldLabel>
              <Input
                id="account-invite-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="account-invite-password">{t("loginPasswordLabel")}</FieldLabel>
              <Input
                id="account-invite-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
                autoComplete="new-password"
              />
              <FieldDescription>{t("accountInvitePasswordDescription")}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="account-invite-password-confirmation">{t("accountInviteConfirmPasswordLabel")}</FieldLabel>
              <Input
                id="account-invite-password-confirmation"
                type="password"
                value={passwordConfirmation}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
                minLength={8}
                required
                autoComplete="new-password"
              />
            </Field>
          </FieldGroup>
          <Button type="submit" disabled={submitting}>
            {submitting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <CheckCircle2 data-icon="inline-start" />}
            {submitting ? t("accountInviteSubmitting") : t("accountInviteAccept")}
          </Button>
        </form>
      </CardContent>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-6">
      <Card className="w-full max-w-lg">{children}</Card>
    </div>
  );
}
