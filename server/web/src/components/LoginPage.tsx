import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "@workflow-code/i18n/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface LoginPageProps {
  emailInput: string;
  passwordInput: string;
  message?: string;
  loading?: string;
  onEmailInputChange: (value: string) => void;
  onPasswordInputChange: (value: string) => void;
  onPasswordSubmit: (e: FormEvent<HTMLFormElement>) => void;
}

export function LoginPage({
  emailInput, passwordInput, message, loading,
  onEmailInputChange, onPasswordInputChange, onPasswordSubmit,
}: LoginPageProps) {
  const { t } = useTranslation("serverWeb");
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 p-6 md:p-10">
      <div className="flex items-center gap-2 font-medium">
        <img src="/brand/workflow-code-icon.svg" alt="" className="size-6" />
        Workflow Code
      </div>
      <div className="w-full max-w-xs">
        <form onSubmit={onPasswordSubmit} className="flex flex-col gap-6">
          <div className="flex flex-col gap-2 text-center">
            <h1 className="text-2xl font-bold">{t("loginCardTitle")}</h1>
            <p className="text-sm text-balance text-muted-foreground">{t("loginCardDescription")}</p>
          </div>
          {message ? (
            <Alert variant="destructive">
              <AlertTitle>{t("loginFailedTitle")}</AlertTitle>
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="login-email">{t("loginEmailLabel")}</FieldLabel>
              <Input id="login-email" type="email" value={emailInput}
                onChange={event => onEmailInputChange(event.target.value)}
                placeholder={t("loginEmailPlaceholder")} autoComplete="username" autoFocus required disabled={!!loading} />
            </Field>
            <Field>
              <FieldLabel htmlFor="login-password">{t("loginPasswordLabel")}</FieldLabel>
              <Input id="login-password" type="password" value={passwordInput}
                onChange={event => onPasswordInputChange(event.target.value)}
                placeholder={t("loginPasswordPlaceholder")} autoComplete="current-password" required disabled={!!loading} />
            </Field>
            <Field>
              <Button type="submit" disabled={!!loading}>
                {loading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                {loading ? t("loginLoading") : t("loginEnterConsole")}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </div>
    </main>
  );
}
