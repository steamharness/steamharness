import { useEffect, useState } from "react";
import { ArrowLeft, CircleAlert, Download, Package, RefreshCw } from "lucide-react";
import { formatDateTime } from "@steamharness/i18n";
import { useTranslation } from "@steamharness/i18n/react";
import { apiClient } from "@/api";
import { isApiSuccess, type SourceShare } from "@/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { IconActionButton } from "@/components/ui/composites";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectVersionShareButton } from "@/components/ProjectVersionShareButton";
import { projectSourceArchivePath } from "@/utils/routes";

export function ProjectSourceSharePage({ id, version, onNavigateProjects }: { id: string; version: string; onNavigateProjects: () => void }) {
  const { t } = useTranslation("serverWeb");
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ loading: boolean; data?: SourceShare; error?: string; requestPath?: string }>({ loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    void apiClient.getSourceShare(id, version, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setState(isApiSuccess(result) && result.data
        ? { loading: false, data: result.data }
        : { loading: false, error: result.errMessage || t("sourceShareUnavailable"), requestPath: accessRequestPath(result.data) });
    });
    return () => controller.abort();
  }, [id, version, revision, t]);
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="flex min-h-14 items-center justify-between gap-4 border-b px-4 lg:px-6">
        <Button variant="ghost" onClick={onNavigateProjects}><ArrowLeft data-icon="inline-start" />{t("sourceShareProjects")}</Button>
        <IconActionButton label={t("commonRefresh")} disabled={state.loading} onClick={() => setRevision(value => value + 1)}><RefreshCw /></IconActionButton>
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 lg:px-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold"><Package className="size-5" />{t("sourceShareTitle")}</h1>
        {state.loading ? <div aria-busy="true" className="flex flex-col gap-4"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40 w-full" /></div>
          : state.error ? <div className="flex flex-col gap-4"><Alert variant="destructive"><CircleAlert /><AlertDescription>{state.error}</AlertDescription></Alert>{state.requestPath && <Button asChild><a href={state.requestPath}>{t("sourceAccessTitle")}</a></Button>}</div>
          : state.data && <Card>
            <CardHeader><CardTitle className="break-words">{state.data.name}</CardTitle><Badge variant="secondary">{state.data.version}</Badge></CardHeader>
            <CardContent>
              <dl className="flex min-w-0 flex-col gap-4 text-sm">
                <div><dt className="text-muted-foreground">{t("storagePublishedAt")}</dt><dd>{formatDateTime(state.data.createdAt)}</dd></div>
                {state.data.releaseLog && <div><dt className="text-muted-foreground">{t("storageReleaseLog")}</dt><dd className="whitespace-pre-wrap break-words">{state.data.releaseLog}</dd></div>}
                <div><dt className="text-muted-foreground">{t("storageSourceHash")}</dt><dd className="break-all font-mono">{state.data.sourceHash}</dd></div>
                <div><dt className="text-muted-foreground">ID</dt><dd className="break-all font-mono">{state.data.id}</dd></div>
              </dl>
            </CardContent>
            <CardFooter className="flex flex-wrap justify-end gap-2">
              <ProjectVersionShareButton id={id} version={version} />
              <Button asChild><a href={projectSourceArchivePath(id, version)}><Download data-icon="inline-start" />{t("storageDownload")}</a></Button>
            </CardFooter>
          </Card>}
      </main>
    </div>
  );
}

function accessRequestPath(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("requestUrl" in data) || typeof data.requestUrl !== "string") return;
  try {
    const url = new URL(data.requestUrl, window.location.origin);
    if (url.origin === window.location.origin && /^\/access-requests\/[^/]+$/.test(url.pathname)) return url.pathname;
  } catch { /* Invalid request links are not navigable. */ }
}
