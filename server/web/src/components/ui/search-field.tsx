import type { InputHTMLAttributes, ReactNode } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./input-group";

export interface SearchFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode;
  hint?: ReactNode;
}

export function SearchField({ icon, hint, className, ...props }: SearchFieldProps) {
  return (
    <InputGroup className={className} data-disabled={props.disabled || undefined}>
      <InputGroupInput type="search" {...props} />
      {icon ? <InputGroupAddon>{icon}</InputGroupAddon> : null}
      {hint ? <InputGroupAddon align="inline-end">{hint}</InputGroupAddon> : null}
    </InputGroup>
  );
}
