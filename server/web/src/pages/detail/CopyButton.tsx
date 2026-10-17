import { useState, type ReactNode } from "react";
import { useTranslation } from "@workflow-code/i18n/react";
import { IconActionButton } from "@/components/ui/composites";
import { cn } from "@/lib/utils";

interface CopyButtonProps {
  value: string;
  label?: string;
  disabled?: boolean;
  className?: string;
  children: (copied: boolean) => ReactNode;
}

export function CopyButton({ value, label, disabled, className, children }: CopyButtonProps) {
  const { t } = useTranslation("serverWeb");
  const resolvedLabel = label ?? t("commonCopy");
  const [copied, setCopied] = useState(false);
  const isDisabled = disabled || value.trim() === "";

  function handleCopy() {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <IconActionButton
      size="icon-xs"
      label={resolvedLabel}
      disabled={isDisabled}
      onClick={handleCopy}
      className={cn(
        "shrink-0 text-muted-foreground hover:bg-muted hover:text-primary disabled:opacity-40",
        className,
      )}
    >
      {children(copied)}
    </IconActionButton>
  );
}
