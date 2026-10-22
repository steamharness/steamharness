import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, LogIn } from "lucide-react";
import { formatDateTime, useTranslation } from "@steamharness/i18n/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiClient } from "../api";
import { isApiSuccess, type InvitationAcceptResult, type InvitationLookupResult } from "../types";

interface InviteAcceptPageProps {
  token: string;
  onNavigateProjects: () => void;
  onNavigateProject: (projectId: string) => void;
  onNavigateLogin: () => void;
  onNavigateGroup?: (id:string)=>void;
}

type InviteState =
  | { phase: "loading" }
  | { phase: "ready"; lookup: InvitationLookupResult }
  | { phase: "missing" }
  | { phase: "expired" }
  | { phase: "revoked" }
  | { phase: "accepted"; result: InvitationAcceptResult; projectId: string }
  | { phase: "error"; message: string };

export function InviteAcceptPage({
  token,
  onNavigateProjects,
  onNavigateProject,
  onNavigateLogin,
  onNavigateGroup,
}: InviteAcceptPageProps) {
  const { t } = useTranslation("serverWeb");
  const [state, setState] = useState<InviteState>({ phase: "loading" });
  const [accepting, setAccepting] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const loadInvitation = useCallback(async () => {
    setState({ phase: "loading" });
    const res = await apiClient.lookupInvitation(token);
    if (!isApiSuccess(res)) {
      const message = res.errMessage || t("inviteLookupFailed");
      if (/not found/i.test(message)) setState({ phase: "missing" });
      else if (/expired/i.test(message)) setState({ phase: "expired" });
      else if (/revoked/i.test(message)) setState({ phase: "revoked" });
      else if (/unauthorized|account login is required/i.test(message)) {
        setSignedIn(false);
        setState({ phase: "error", message: t("inviteLoginRequiredMessage") });
        return;
      }
      else setState({ phase: "error", message });
      return;
    }
    setSignedIn(true);
    const lookup = res.data;
    if (lookup.invitation.acceptedAt) {
      setState({ phase: "accepted", result: { invitation: lookup.invitation }, projectId: lookup.project.id });
      return;
    }
    if (lookup.invitation.revokedAt) setState({ phase: "revoked" });
    else if (Date.parse(lookup.invitation.expiresAt) <= Date.now()) setState({ phase: "expired" });
    else setState({ phase: "ready", lookup });
  }, [token]);

  useEffect(() => {
    void loadInvitation();
  }, [loadInvitation]);

  async function accept() {
    setAccepting(true);
    const res = await apiClient.acceptInvitation(token);
    setAccepting(false);
    if (!isApiSuccess(res)) {
      const message = res.errMessage || t("inviteAcceptFailed");
      if (/expired/i.test(message)) setState({ phase: "expired" });
      else if (/revoked/i.test(message)) setState({ phase: "revoked" });
      else if (/already/i.test(message)) setState({ phase: "error", message: t("inviteAlreadyAccepted") });
      else if (/unauthorized|account login is required/i.test(message)) {
        setSignedIn(false);
        setState({ phase: "error", message: t("inviteSessionExpired") });
        return;
      }
      else setState({ phase: "error", message });
      return;
    }
    setState({ phase: "accepted", result: res.data, projectId: res.data.invitation.projectId });
  }

  if (state.phase === "loading") {
    return (
      <CenteredCard>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          {t("inviteReading")}
        </CardContent>
      </CenteredCard>
    );
  }

  if (state.phase === "missing") {
    return (
      <CenteredCard>
        <CardHeader>
          <CardTitle className="text-base">{t("inviteMissingTitle")}</CardTitle>
          <CardDescription>{t("inviteMissingDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onNavigateProjects}>{t("appHeaderBackToProjects")}</Button>
        </CardContent>
      </CenteredCard>
    );
  }

  if (state.phase === "expired") {
    return (
      <CenteredCard>
        <CardHeader>
          <CardTitle className="text-base">{t("inviteExpiredTitle")}</CardTitle>
          <CardDescription>{t("inviteExpiredDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onNavigateProjects}>{t("appHeaderBackToProjects")}</Button>
        </CardContent>
      </CenteredCard>
    );
  }

  if (state.phase === "revoked") {
    return (
      <CenteredCard>
        <CardHeader>
          <CardTitle className="text-base">{t("inviteRevokedTitle")}</CardTitle>
          <CardDescription>{t("inviteRevokedDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onNavigateProjects}>{t("appHeaderBackToProjects")}</Button>
        </CardContent>
      </CenteredCard>
    );
  }

  if (state.phase === "error") {
    const requiresLogin = signedIn === false;
    return (
      <CenteredCard>
        <CardHeader>
          <CardTitle className="text-base">{requiresLogin ? t("inviteErrorTitleLoginRequired") : t("inviteErrorTitleUnable")}</CardTitle>
          <CardDescription>
            {requiresLogin
              ? t("inviteLoginRequiredDescription")
              : state.message}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {requiresLogin ? (
            <Button onClick={onNavigateLogin}>
              <LogIn data-icon="inline-start" /> {t("inviteLoginFirst")}
            </Button>
          ) : (
            <Button onClick={() => void loadInvitation()}>{t("commonRetry")}</Button>
          )}
          <Button variant="outline" onClick={onNavigateProjects}>{t("appHeaderBackToProjects")}</Button>
        </CardContent>
      </CenteredCard>
    );
  }

  if (state.phase === "accepted") {
    return (
      <CenteredCard>
        <CardContent className="flex flex-col items-center gap-3 py-10">
          <CheckCircle2 className="size-8 text-foreground" />
          <div className="text-base font-semibold text-foreground">{t("inviteSuccessJoined", { projectId: state.result.invitation.projectId })}</div>
          <div className="text-sm text-muted-foreground">{t("inviteRoleLabel")}{state.result.invitation.role}</div>
          <div className="flex gap-2 pt-2">
            <Button onClick={() => state.result.invitation.resourceType=== "group"?onNavigateGroup?.(state.projectId):onNavigateProject(state.projectId)}>{t("inviteOpenProject")}</Button>
            <Button variant="outline" onClick={onNavigateProjects}>{t("appHeaderBackToProjects")}</Button>
          </div>
        </CardContent>
      </CenteredCard>
    );
  }

  const { lookup } = state;
  return (
    <CenteredCard>
      <CardHeader>
        <CardTitle className="text-base">{t("inviteTitleJoin", { name: lookup.project.name })}</CardTitle>
        <CardDescription>
          {t("inviteRoleBefore")} <strong>{lookup.invitation.role}</strong> {t("inviteRoleAfter", { expiresAt: formatDateTime(lookup.invitation.expiresAt) })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground">
          {t("inviteProjectId")}<span className="font-mono">{lookup.project.id}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void accept()} disabled={accepting}>
            {accepting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <CheckCircle2 data-icon="inline-start" />}
            {t("inviteAcceptAndJoin")}
          </Button>
          <Button variant="outline" onClick={onNavigateLogin}>{t("inviteSignInOther")}</Button>
        </div>
      </CardContent>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        {children}
      </Card>
    </div>
  );
}