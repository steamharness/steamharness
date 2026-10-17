import { useId, useState } from "react";
import { Check, Copy, Download, Share2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@steamharness/i18n/react";
import { Button } from "@/components/ui/button";
import { IconActionButton } from "@/components/ui/composites";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { projectSourceArchivePath, projectSourceSharePath } from "@/utils/routes";

export function ProjectVersionShareButton({ id, version, disabled }: { id: string; version: string; disabled?: boolean }) {
  const { t } = useTranslation("serverWeb");
  const inputId = useId();
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = new URL(projectSourceSharePath(id, version), window.location.origin).href;
  async function copy() {
    if (copying) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t("sourceShareCopied"));
    } catch { toast.error(t("sourceShareCopyFailed")); }
    finally { setCopying(false); }
  }
  return (
    <Dialog onOpenChange={() => setCopied(false)}>
      <DialogTrigger asChild><IconActionButton label={t("sourceShare")} disabled={disabled}><Share2 /></IconActionButton></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("sourceShareVersion", { version })}</DialogTitle>
          <DialogDescription>{t("sourceSharePermission")}</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor={inputId}>{t("sourceShareLink")}</FieldLabel>
          <InputGroup>
            <InputGroupInput id={inputId} value={url} readOnly onFocus={event => event.currentTarget.select()} />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" title={t("sourceShareCopy")} aria-label={t("sourceShareCopy")} disabled={copying} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </Field>
        <DialogFooter><Button asChild><a href={projectSourceArchivePath(id, version)}><Download data-icon="inline-start" />{t("storageDownload")}</a></Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
