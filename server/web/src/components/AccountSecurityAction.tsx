import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "@steamharness/i18n/react";
import { Loader2Icon } from "lucide-react";
import { apiClient } from "../api";
import { isApiSuccess } from "../types";
import { type CodeChallenge } from "./LoginPage";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface AccountSecurity {
  username: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  hasPassword: boolean;
}
type SecurityAction = "bind-email" | "verify-email" | "change-email" | "unbind-email" | "password" | "username";
const normalizeEmail = (email: string) => email.trim().toLowerCase();

// Only delivery limits survive closing a dialog. Challenges belong
// to the mounted operation; the Server rate limit applies to an address across purposes.
export function useEmailCodeCooldowns() {
  const [deadlines, setDeadlines] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now);
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const sendingRef = useRef(new Set<string>());
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!Object.values(deadlines).some(deadline => deadline > now)) return;
    const timer = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(timer);
  }, [deadlines, now]);
  return {
    remaining: (email: string) => Math.max(0, Math.ceil(((deadlines[normalizeEmail(email)] || 0) - now) / 1000)),
    isSending: (email: string) => !!sending[normalizeEmail(email)],
    begin(email: string) {
      const key = normalizeEmail(email);
      if (sendingRef.current.has(key)) return false;
      sendingRef.current.add(key);
      setSending(value => ({ ...value, [key]: true }));
      return true;
    },
    finish(email: string) {
      const key = normalizeEmail(email);
      sendingRef.current.delete(key);
      if (active.current) setSending(value => ({ ...value, [key]: false }));
    },
    start(email: string, seconds: number) {
      if (!active.current) return;
      const timestamp = Date.now();
      setNow(timestamp);
      setDeadlines(value => ({ ...value, [normalizeEmail(email)]: timestamp + seconds * 1000 }));
    },
  };
}

interface ActionProps {
  security: AccountSecurity;
  action: SecurityAction;
  mail: boolean;
  disabled: boolean;
  cooldowns: ReturnType<typeof useEmailCodeCooldowns>;
  onComplete: (signInRequired: boolean) => void | Promise<void>;
}

export function AccountSecurityAction(props: ActionProps) {
  const { t } = useTranslation("serverWeb");
  const [open, setOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const title = t(props.action === "password" ? props.security.hasPassword ? "authChangePassword" : "authSetPassword"
    : props.action === "username" ? "authSetUsername" : props.action === "bind-email" ? "authBindEmail"
      : props.action === "verify-email" ? "authVerifyEmail" : props.action === "change-email" ? "authChangeEmail" : "authUnbindEmail");
  return <Dialog open={open} onOpenChange={value => { if (!committing) setOpen(value); }}>
    <DialogTrigger asChild><Button variant="outline" disabled={props.disabled}>{title}</Button></DialogTrigger>
    {open ? <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto" showCloseButton={!committing}
      onEscapeKeyDown={event => { if (committing) event.preventDefault(); }}
      onInteractOutside={event => { if (committing) event.preventDefault(); }}>
      <SecurityActionForm {...props} title={title} onCommitting={setCommitting} onCancel={() => setOpen(false)}
        onComplete={signInRequired => { setCommitting(false); setOpen(false); return props.onComplete(signInRequired); }} />
    </DialogContent> : null}
  </Dialog>;
}

function SecurityActionForm({ action, security, mail, cooldowns, title, onCommitting, onCancel, onComplete }: ActionProps & {
  title: string;
  onCommitting: (value: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("serverWeb");
  const binding = action === "bind-email" || action === "verify-email" || action === "change-email";
  const [email, setEmail] = useState(action === "verify-email" ? security.email || "" : "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<"target" | "save" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef(true);
  const requestPending = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { formRef.current?.querySelector<HTMLInputElement>("input:not([disabled]):not([readonly])")?.focus(); }, []);

  const busy = pending !== null;
  const emailUnchanged = action === "change-email" && normalizeEmail(email) === normalizeEmail(security.email || "");
  const targetCooldown = cooldowns.remaining(email);

  function clearFeedback() { setError(""); setNotice(""); }
  async function send() {
    const address = normalizeEmail(email);
    if (requestPending.current || !mail || cooldowns.remaining(address) || emailUnchanged || !emailRef.current?.reportValidity()) return;
    if (!cooldowns.begin(address)) return;
    requestPending.current = true;
    setPending("target"); clearFeedback();
    setChallenge(""); setCode("");
    try {
      const result = await apiClient.authAction<CodeChallenge>("/email-code/send", { email: address, purpose: "bind-email" });
      if (isApiSuccess(result)) cooldowns.start(address, result.data.retryAfterSeconds);
      if (!active.current) return;
      if (!isApiSuccess(result)) { setError(result.errMessage); return; }
      setChallenge(result.data.challengeId);
      setNotice(t("authTargetEmailCodeSent", { email: address }));
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : t("authConfigFailed"));
    } finally {
      cooldowns.finish(address);
      requestPending.current = false;
      if (active.current) setPending(null);
    }
  }

  async function save() {
    if (requestPending.current || (binding && (!mail || !challenge || !/^\d{6}$/.test(code) || emailUnchanged))) return;
    requestPending.current = true; setPending("save"); onCommitting(true); clearFeedback();
    let succeeded = false;
    try {
      const path = action === "username" ? "/me/username" : action === "password" ? "/me/password" : "/me/email";
      const data = action === "username" ? { username: username.trim() } : action === "password" ? { password }
        : action === "unbind-email" ? { action: "unbind" } : { action: "bind", challengeId: challenge, code };
      const result = await apiClient.authAction(path, data);
      if (!active.current) return;
      succeeded = isApiSuccess(result);
      if (!succeeded) setError(result.errMessage);
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : t("authConfigFailed"));
    } finally {
      requestPending.current = false;
      if (active.current) {
        setPending(null); onCommitting(false);
        // The Server may consume the target code before a later account update fails.
        if (binding) { setChallenge(""); setCode(""); }
        if (!succeeded && binding) setNotice(t("authFreshCodeRequired"));
      }
    }
    if (succeeded && active.current) await onComplete(action !== "username");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestPending.current || !event.currentTarget.reportValidity()) return;
    if (action === "password" && password !== confirmation) { setError(t("accountInvitePasswordMismatch")); return; }
    void save();
  }

  const description = action === "username" ? "authUsernameHelp" : action === "unbind-email" ? "authUnbindConfirm"
    : action === "password" ? "authPasswordRevokeHelp" : "authEmailRevokeHelp";
  const targetCodeLabel = t(action === "verify-email" ? "authEmailVerificationCode" : "authNewEmailCode");
  return <>
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{t(description)}</DialogDescription></DialogHeader>
    <form ref={formRef} onSubmit={submit} aria-label={title} aria-busy={busy}>
      <FieldGroup>
        {binding ? <>
          <Field data-disabled={busy}>
            <FieldLabel htmlFor="security-target-email">{t(action === "verify-email" ? "loginEmailLabel" : "authNewEmail")}</FieldLabel>
            <Input ref={emailRef} id="security-target-email" name="new-email" type="email" required maxLength={254} autoComplete="section-security-target email"
              value={email} readOnly={action === "verify-email"} disabled={busy} onChange={event => { setEmail(event.target.value); setChallenge(""); setCode(""); clearFeedback(); }} />
            {emailUnchanged ? <FieldDescription>{t("authEmailAlreadyBound")}</FieldDescription> : null}
          </Field>
          <Field data-disabled={busy}>
            <FieldLabel htmlFor="security-target-code">{targetCodeLabel}</FieldLabel>
            <Input id="security-target-code" name="target-email-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="section-security-target one-time-code" required
              value={code} onChange={event => setCode(event.target.value)} disabled={busy || !challenge} />
            <Button type="button" variant="outline" aria-busy={pending === "target" || cooldowns.isSending(email)} disabled={busy || cooldowns.isSending(email) || !mail || emailUnchanged || targetCooldown > 0 || !email.trim()} onClick={() => void send()}>
              {pending === "target" || cooldowns.isSending(email) ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : null}
              {targetCooldown ? t("authResendCountdown", { seconds: targetCooldown }) : t(action === "verify-email" ? "authSendCode" : "authSendNewEmailCode")}
            </Button>
          </Field>
        </> : null}
        {action === "password" ? <>
          <Field data-disabled={busy}><FieldLabel htmlFor="security-new-password">{t("authNewPassword")}</FieldLabel>
            <Input id="security-new-password" name="new-password" type="password" required minLength={8} maxLength={4096} autoComplete="section-security-new new-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></Field>
          <Field data-disabled={busy} data-invalid={!!confirmation && password !== confirmation}><FieldLabel htmlFor="security-confirm-password">{t("accountInviteConfirmPasswordLabel")}</FieldLabel>
            <Input id="security-confirm-password" name="confirm-new-password" type="password" required minLength={8} maxLength={4096} autoComplete="section-security-new new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} aria-invalid={!!confirmation && password !== confirmation} disabled={busy} /></Field>
        </> : null}
        {action === "username" ? <Field data-disabled={busy}><FieldLabel htmlFor="security-new-username">{t("authUsername")}</FieldLabel>
          <Input id="security-new-username" name="new-username" required minLength={3} maxLength={32} pattern={"[A-Za-z0-9][A-Za-z0-9_\\-]{2,31}"} autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} disabled={busy} /></Field> : null}
        {action === "unbind-email" ? <p className="break-all text-sm">{security.email}</p> : null}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {notice ? <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert> : null}
      </FieldGroup>
      <DialogFooter className="mt-6">
        <Button type="button" variant="outline" disabled={pending === "save"} onClick={onCancel}>{t("commonCancel")}</Button>
        <Button type="submit" variant={action === "unbind-email" ? "destructive" : "default"} aria-busy={pending === "save"}
          disabled={busy || (binding && (!mail || !challenge || !/^\d{6}$/.test(code) || emailUnchanged))}>
          {pending === "save" ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : null}{title}
        </Button>
      </DialogFooter>
    </form>
  </>;
}
