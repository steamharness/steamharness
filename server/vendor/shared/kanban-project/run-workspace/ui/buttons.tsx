import type { ReactNode } from "react";
import { runActionButtonClassName } from "../styles";

export function SecondaryButton({
  children,
  disabled,
  onClick,
  title,
  square,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  square?: boolean;
}) {
  return (
    <button
      type="button"
      data-slot="rwi-button-secondary"
      className={runActionButtonClassName("secondary", { square })}
      disabled={disabled}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}
