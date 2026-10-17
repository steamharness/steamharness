import type { ComponentProps } from "react";
import { useTranslation } from "@workflow-code/i18n/react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./select";
import { cn } from "@/lib/utils";

const EMPTY_VALUE = "__empty_value__";
type SelectChangeEvent = { target: { value: string }; currentTarget: { value: string } };

export type SelectFieldProps = Omit<ComponentProps<typeof Select>, "value" | "defaultValue"> & {
  options: Array<{ label: string; value: string }>;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  size?: "sm" | "default";
  id?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  onClick?: ComponentProps<typeof SelectTrigger>["onClick"];
  onKeyDown?: ComponentProps<typeof SelectTrigger>["onKeyDown"];
  onChange?: (event: SelectChangeEvent) => void;
};

export function SelectField({
  options, value, defaultValue, placeholder, className, triggerClassName, contentClassName,
  size, id, "aria-label": label, "aria-invalid": invalid, onClick, onKeyDown,
  onChange, onValueChange, ...props
}: SelectFieldProps) {
  const { t } = useTranslation("serverWeb");
  return (
    <Select {...props} value={value === "" ? EMPTY_VALUE : value}
      defaultValue={defaultValue === "" ? EMPTY_VALUE : defaultValue}
      onValueChange={next => {
        const selected = next === EMPTY_VALUE ? "" : next;
        onValueChange?.(selected);
        onChange?.({ target: { value: selected }, currentTarget: { value: selected } });
      }}>
      <SelectTrigger className={cn("w-full min-w-0", className, triggerClassName)} size={size}
        id={id} aria-label={label} aria-invalid={invalid} onClick={onClick} onKeyDown={onKeyDown}>
        <SelectValue placeholder={placeholder ?? options[0]?.label ?? t("selectPlaceholder")} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        <SelectGroup>
          {options.map(option => <SelectItem key={option.value} value={option.value || EMPTY_VALUE}>{option.label}</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
