import { useRef, type ChangeEvent, type ComponentProps, type ReactNode } from "react";
import { Inbox } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";

import { AvatarPreviewDialog } from "@/components/AvatarPreviewDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type ButtonProps = ComponentProps<typeof Button>;
type BadgeProps = ComponentProps<typeof Badge>;
type IconButtonSize = Extract<ButtonProps["size"], "icon" | "icon-xs" | "icon-sm" | "icon-lg">;

type IconActionButtonProps = Omit<ButtonProps, "size" | "aria-label" | "title"> & {
  label: string;
  title?: string;
  size?: IconButtonSize;
  danger?: boolean;
};

function IconActionButton({
  label,
  title,
  size = "icon-sm",
  variant,
  danger,
  className,
  asChild,
  ...props
}: IconActionButtonProps) {
  return (
    <Button
      type={asChild ? undefined : "button"}
      asChild={asChild}
      variant={variant ?? (danger ? "destructive" : "ghost")}
      size={size}
      aria-label={label}
      title={title ?? label}
      data-ui="icon-action-button"
      className={cn("shrink-0", className)}
      {...props}
    />
  );
}

type TableActionCellProps = ComponentProps<typeof TableCell> & {
  contentClassName?: string;
};

function TableActionCell({ children, className, contentClassName, ...props }: TableActionCellProps) {
  return (
    <TableCell className={cn("text-right", className)} {...props}>
      <div data-ui="table-action-cell" className={cn("flex items-center justify-end gap-1", contentClassName)}>
        {children}
      </div>
    </TableCell>
  );
}

type TableEmptyRowProps = Omit<ComponentProps<typeof TableRow>, "children"> & {
  colSpan: number;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  emptyClassName?: string;
  cellClassName?: string;
};

function TableEmptyRow({
  colSpan,
  title,
  description,
  icon = <Inbox />,
  action,
  className,
  emptyClassName,
  cellClassName,
  ...props
}: TableEmptyRowProps) {
  return (
    <TableRow data-ui="table-empty-row" className={className} {...props}>
      <TableCell colSpan={colSpan} className={cn("p-0 whitespace-normal", cellClassName)}>
        <Empty className={cn("min-h-32 border-0", emptyClassName)}>
          <EmptyHeader>
            {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
            <EmptyTitle>{title}</EmptyTitle>
            {description ? <EmptyDescription>{description}</EmptyDescription> : null}
          </EmptyHeader>
          {action ? <EmptyContent>{action}</EmptyContent> : null}
        </Empty>
      </TableCell>
    </TableRow>
  );
}

type SettingsFieldProps = Omit<ComponentProps<typeof Field>, "children"> & {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
  contentClassName?: string;
};

function SettingsField({
  label,
  description,
  htmlFor,
  children,
  orientation = "vertical",
  className,
  contentClassName,
  ...props
}: SettingsFieldProps) {
  return (
    <Field
      orientation={orientation}
      className={className}
      data-ui="settings-field"
      {...props}
    >
      <FieldContent className={contentClassName}>
        <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
        {description ? <FieldDescription>{description}</FieldDescription> : null}
      </FieldContent>
      {children}
    </Field>
  );
}

type FilePickerPreview = {
  src?: string;
  alt?: string;
  fallback: ReactNode;
};

type FilePickerFieldProps = Omit<ComponentProps<typeof Field>, "children" | "onChange"> & {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  accept?: string;
  disabled?: boolean;
  chooseLabel?: string;
  preview?: FilePickerPreview;
  actions?: ReactNode;
  onFileChange: (file: File | null, event: ChangeEvent<HTMLInputElement>) => void;
};

function FilePickerField({
  id,
  label,
  description,
  accept,
  disabled,
  chooseLabel,
  preview,
  actions,
  onFileChange,
  className,
  ...props
}: FilePickerFieldProps) {
  const { t } = useTranslation(["serverWeb", "common"]);
  const inputRef = useRef<HTMLInputElement>(null);
  const resolvedChooseLabel = chooseLabel ?? t("filePickerChoose");
  const previewLabel = t("common:attachmentPreview", { name: preview?.alt || t("accountAvatarLabel") });

  return (
    <Field className={className} data-ui="file-picker-field" {...props}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex flex-wrap items-center gap-3">
        {preview ? (
          <AvatarPreviewDialog src={preview.src} alt={preview.alt} fallback={preview.fallback} label={previewLabel}>
            <Button type="button" variant="ghost" className="size-8 shrink-0 rounded-md p-0"
              title={previewLabel} aria-label={previewLabel} onClick={event => event.stopPropagation()}>
              <Avatar>
                {preview.src ? <AvatarImage src={preview.src} alt={preview.alt ?? ""} /> : null}
                <AvatarFallback>{preview.fallback}</AvatarFallback>
              </Avatar>
            </Button>
          </AvatarPreviewDialog>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            id={id}
            type="file"
            accept={accept}
            className="sr-only"
            disabled={disabled}
            onChange={(event) => onFileChange(event.target.files?.[0] ?? null, event)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            {resolvedChooseLabel}
          </Button>
          {actions}
        </div>
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

type SemanticTone = "default" | "success" | "warning" | "danger" | "running" | "waiting" | "info" | "muted" | "outline";
type BadgeVariant = NonNullable<BadgeProps["variant"]>;

const SEMANTIC_BADGE_VARIANTS: Record<SemanticTone, BadgeVariant> = {
  default: "secondary",
  success: "secondary",
  warning: "outline",
  danger: "destructive",
  running: "secondary",
  waiting: "outline",
  info: "secondary",
  muted: "outline",
  outline: "outline",
};

type SemanticBadgeProps = Omit<BadgeProps, "variant"> & {
  tone?: SemanticTone;
};

function SemanticBadge({ tone = "default", className, ...props }: SemanticBadgeProps) {
  return (
    <Badge
      variant={SEMANTIC_BADGE_VARIANTS[tone]}
      data-tone={tone}
      className={className}
      {...props}
    />
  );
}

export {
  FilePickerField,
  IconActionButton,
  SemanticBadge,
  SettingsField,
  TableActionCell,
  TableEmptyRow,
  type FilePickerFieldProps,
  type IconActionButtonProps,
  type SemanticBadgeProps,
  type SettingsFieldProps,
  type TableActionCellProps,
  type TableEmptyRowProps,
};
