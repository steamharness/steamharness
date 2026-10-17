import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { CheckCircle2, FileLock2, Loader2 } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "../api";
import {
  isApiSuccess,
  type WorkflowProjectAccessLinkInfo,
  type WorkflowProjectAccessRequest,
} from "../types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

type AccessRequestState =
  | { phase: "loading" }
  | { phase: "ready"; project: WorkflowProjectAccessLinkInfo }
  | { phase: "submitted"; project: WorkflowProjectAccessLinkInfo; request: WorkflowProjectAccessRequest }
  | { phase: "error"; message: string };

export function ProjectSourceAccessRequestPage({
  token,
  onNavigateProjects,
}: {
  token: string;
  onNavigateProjects: () => void;
}) {
  const { t } = useTranslation("serverWeb");
  const [state, setState] = useState<AccessRequestState>({ phase: "loading" });
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    void apiClient.getProjectSourceAccessLink(token).then((response) => {
      if (cancelled) return;
      setState(isApiSuccess(response)
        ? { phase: "ready", project: response.data }
        : { phase: "error", message: response.errMessage || t("sourceAccessLoadFailed") });
    }).catch((error: unknown) => {
      if (!cancelled) {
        setState({ phase: "error", message: error instanceof Error ? error.message : t("sourceAccessLoadFailed") });
      }
    });
    return () => { cancelled = true; };
  }, [t, token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.phase !== "ready" || submitting) return;
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 2) {
      setValidationError(t("sourceAccessReasonTooShort"));
      return;
    }
    setSubmitting(true);
    setValidationError("");
    const response = await apiClient.createProjectSourceAccessRequest(token, normalizedReason);
    setSubmitting(false);
    if (!isApiSuccess(response)) {
      setValidationError(response.errMessage || t("sourceAccessSubmitFailed"));
      return;
    }
    setState({ phase: "submitted", project: state.project, request: response.data });
  }

  if (state.phase === "loading") {
    return (
      <CenteredPage>
        <Card className="w-full max-w-lg">
          <CardContent className="flex min-h-52 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="animate-spin" aria-hidden="true" />
            {t("sourceAccessCheckingLink")}
          </CardContent>
        </Card>
      </CenteredPage>
    );
  }

  if (state.phase === "error") {
    return (
      <CenteredPage>
        <Card className="w-full max-w-lg">
          <CardContent>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><FileLock2 /></EmptyMedia>
                <EmptyTitle>{t("sourceAccessLinkUnavailableTitle")}</EmptyTitle>
                <EmptyDescription>{state.message}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={onNavigateProjects}>{t("sourceAccessBackToProjects")}</Button>
              </EmptyContent>
            </Empty>
          </CardContent>
        </Card>
      </CenteredPage>
    );
  }

  if (state.phase === "submitted") {
    return (
      <CenteredPage>
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 aria-hidden="true" />
              {t("sourceAccessSubmittedTitle")}
            </CardTitle>
            <CardDescription>
              {t("sourceAccessSubmittedDescription", { projectName: state.project.projectName })}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
            <span>{t("sourceAccessCurrentStatus", { status: state.request.status === "pending" ? t("sourceAccessPending") : state.request.status })}</span>
            <span className="font-mono text-xs break-all">{t("sourceAccessRequestId", { id: state.request.id })}</span>
          </CardContent>
          <CardFooter>
            <Button onClick={onNavigateProjects}>{t("sourceAccessBackToProjects")}</Button>
          </CardFooter>
        </Card>
      </CenteredPage>
    );
  }

  return (
    <CenteredPage>
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t("sourceAccessTitle")}</CardTitle>
          <CardDescription>
            {t("sourceAccessDescription", { projectName: state.project.projectName })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form id="project-source-access-form" onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              <Field data-invalid={validationError !== ""}>
                <FieldLabel htmlFor="project-source-access-reason">{t("sourceAccessReasonLabel")}</FieldLabel>
                <Textarea
                  id="project-source-access-reason"
                  value={reason}
                  maxLength={1000}
                  rows={5}
                  disabled={submitting}
                  aria-invalid={validationError !== ""}
                  placeholder={t("sourceAccessReasonPlaceholder")}
                  onChange={(event) => {
                    setReason(event.target.value);
                    if (validationError) setValidationError("");
                  }}
                />
                <FieldDescription>{t("sourceAccessReasonDescription")}</FieldDescription>
                {validationError ? <FieldError>{validationError}</FieldError> : null}
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button type="button" variant="outline" disabled={submitting} onClick={onNavigateProjects}>{t("commonCancel")}</Button>
          <Button type="submit" form="project-source-access-form" disabled={submitting}>
            {submitting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <FileLock2 data-icon="inline-start" />}
            {submitting ? t("sourceAccessSubmitting") : t("sourceAccessSubmit")}
          </Button>
        </CardFooter>
      </Card>
    </CenteredPage>
  );
}

function CenteredPage({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      {children}
    </main>
  );
}
