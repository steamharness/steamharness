import { useState } from "react";
import { CircleAlert, Download, Package } from "lucide-react";
import { useTranslation } from "@workflow-code/i18n/react";
import { formatDateTime } from "@workflow-code/i18n";
import { Badge, IconActionButton, PaginationFooter, TablePanel, TableActionCell, TableBody, TableCell, TableEmptyRow, TableHead, TableHeader, TableRow } from "@/components/ui";
import { TableLoadingRows } from "@/components/ui/table-loading-rows";
import { PageStats } from "@/components/ui/page-stats";
import { UserIdentity } from "@/components/UserIdentity";
import { ProjectVersionShareButton } from "@/components/ProjectVersionShareButton";
import { projectSourceArchivePath } from "@/utils/routes";
import type { DetailPageProps } from "./types";

export function VersionsTab({ project, detail, busy }: DetailPageProps) {
  const { t, i18n } = useTranslation("serverWeb");
  const [page, setPage] = useState(0);
  const versions = [...(detail.versions?.versions ?? [])].reverse();
  const pageCount = Math.max(1, Math.ceil(versions.length / 20));
  const safePage = Math.min(page, pageCount - 1);
  const rows = versions.slice(safePage * 20, safePage * 20 + 20);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-base font-semibold">{t("storageVersions")}</h2>
        <PageStats items={[
          { label: t("storageVersions"), value: busy.project ? "-" : versions.length.toLocaleString(i18n.language) },
          { label: t("storageDownloadCount"), value: busy.project || !detail.versions ? "-" : detail.versions.totalDownloadCount.toLocaleString(i18n.language) },
        ]} />
      </div>
      <TablePanel className="min-w-[1120px]" panelClassName="flex-1" footer={
        <PaginationFooter total={versions.length} pageIndex={safePage} pageSize={20} rowsOnPage={rows.length} previousDisabled={safePage === 0 || !!busy.project} nextDisabled={safePage === pageCount - 1 || !!busy.project} onPrevious={() => setPage(Math.max(0, safePage - 1))} onNext={() => setPage(safePage + 1)} />
      }>
        <TableHeader><TableRow><TableHead>{t("storageVersion")}</TableHead><TableHead className="text-right">{t("storageDownloadCount")}</TableHead><TableHead>{t("storagePublishedAt")}</TableHead><TableHead>{t("projectListHeaderUploader")}</TableHead><TableHead>{t("storageReleaseLog")}</TableHead><TableHead>{t("storageSourceHash")}</TableHead><TableHead className="text-right">{t("dependenciesHeaderActions")}</TableHead></TableRow></TableHeader>
        <TableBody>
          {busy.project ? <TableLoadingRows colSpan={7} /> : detail.loadErrors?.versions ? <TableEmptyRow colSpan={7} icon={<CircleAlert />} title={detail.loadErrors.versions} /> : rows.length === 0 ? <TableEmptyRow colSpan={7} icon={<Package />} title={t("storageNoVersions")} /> : rows.map(version => (
            <TableRow key={version.version}>
              <TableCell className="font-mono">{version.version} {version.latest && <Badge variant="secondary">latest</Badge>}</TableCell>
              <TableCell className="text-right tabular-nums">{version.downloadCount.toLocaleString(i18n.language)}</TableCell>
              <TableCell className="whitespace-nowrap">{version.createdAt ? formatDateTime(version.createdAt) : "-"}</TableCell>
              <TableCell><UserIdentity user={{userId: version.createdByUserId, ...version.createdByProfile}} /></TableCell>
              <TableCell className="max-w-md whitespace-pre-wrap break-words">{version.releaseLog || "-"}</TableCell>
              <TableCell className="max-w-40 truncate font-mono" title={version.sourceHash}>{version.sourceHash ?? "-"}</TableCell>
              <TableActionCell>
                <ProjectVersionShareButton id={project.id} version={version.version} disabled={!project.sourceDownload?.allowed} />
                <IconActionButton label={t("storageDownload")} disabled={!project.sourceDownload?.allowed} onClick={() => window.location.assign(projectSourceArchivePath(project.id, version.version))}><Download /></IconActionButton>
              </TableActionCell>
            </TableRow>
          ))}
        </TableBody>
      </TablePanel>
    </div>
  );
}
