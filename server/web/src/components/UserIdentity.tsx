import type { ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { i18n, useTranslation } from "@steamharness/i18n/react";
import { cn } from "@/lib/utils";
import { getAvatarFallbackText } from "@steamharness/avatar-fallback";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export interface UserIdentityValue {
  userId?: string | null;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

type UserIdentitySize = "xs" | "sm" | "md";

interface UserIdentityProps {
  user?: UserIdentityValue | null;
  fallbackLabel?: string;
  secondary?: ReactNode;
  badge?: ReactNode;
  size?: UserIdentitySize;
  showEmail?: boolean;
  showUserId?: boolean;
  className?: string;
  contentClassName?: string;
  interactive?: boolean;
}

const SIZE_STYLES: Record<UserIdentitySize, {
  avatar: string;
  fallbackText: string;
  primary: string;
  secondary: string;
}> = {
  xs: {
    avatar: "size-7",
    fallbackText: "text-[10px]",
    primary: "text-xs",
    secondary: "text-xs",
  },
  sm: {
    avatar: "size-8",
    fallbackText: "text-xs",
    primary: "text-sm",
    secondary: "text-xs",
  },
  md: {
    avatar: "size-10",
    fallbackText: "text-xs",
    primary: "text-sm",
    secondary: "text-xs",
  },
};

function normalizeIdentityText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function getUserIdentityPrimary(user: UserIdentityValue | null | undefined, fallbackLabel?: string): string {
  return (
    normalizeIdentityText(user?.displayName) ??
    normalizeIdentityText(user?.email) ??
    normalizeIdentityText(user?.userId) ??
    fallbackLabel ??
    i18n.t("usersUnrecordedUser", { ns: "serverWeb" })
  );
}

export function createUserIdentitySearchText(user: UserIdentityValue | null | undefined): string {
  return [
    user?.displayName,
    user?.email,
    user?.userId,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function UserIdentity({
  user,
  fallbackLabel,
  secondary,
  badge,
  size = "sm",
  showEmail = true,
  showUserId = true,
  className,
  contentClassName,
  interactive = true,
}: UserIdentityProps) {
  const { t } = useTranslation("serverWeb");
  const styles = SIZE_STYLES[size];
  const displayName = normalizeIdentityText(user?.displayName);
  const email = normalizeIdentityText(user?.email);
  const userId = normalizeIdentityText(user?.userId);
  const avatarUrl = normalizeIdentityText(user?.avatarUrl);
  const primary = getUserIdentityPrimary(user, fallbackLabel ?? t("usersUnrecordedUser"));
  const emailLine = showEmail && email && email !== primary ? email : undefined;
  const userIdLine = showUserId && userId && userId !== primary && userId !== emailLine ? userId : undefined;
  const avatar = (large = false) => <Avatar className={cn(large ? "size-32" : styles.avatar, "shrink-0")}>
    {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
    <AvatarFallback>
      <span className={cn("font-semibold", large ? "text-3xl" : styles.fallbackText)}>{getAvatarFallbackText({ displayName, email, userId }, "?")}</span>
    </AvatarFallback>
  </Avatar>;
  const profileLabel = t("userIdentityDetails", { name: primary });

  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      {interactive ? <Dialog>
        <DialogTrigger asChild><Button type="button" variant="ghost" className={cn(styles.avatar, "shrink-0 rounded-md p-0")}
          title={profileLabel} aria-label={profileLabel} onClick={event => event.stopPropagation()}>{avatar()}</Button></DialogTrigger>
        <DialogContent aria-describedby={undefined} onClick={event => event.stopPropagation()}>
          <DialogHeader><DialogTitle>{primary}</DialogTitle></DialogHeader>
          <div className="flex min-w-0 flex-col items-center gap-3">
            {avatar(true)}
            {emailLine ? <p className="max-w-full break-all text-sm">{emailLine}</p> : null}
            {userIdLine ? <p className="max-w-full break-all font-mono text-xs text-muted-foreground">{userIdLine}</p> : null}
          </div>
        </DialogContent>
      </Dialog> : avatar()}
      <div className={cn("grid min-w-0 flex-1 gap-0.5 text-left leading-tight", contentClassName)}>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate font-medium text-foreground", styles.primary)} title={primary}>
            {primary}
          </span>
          {badge ? <span className="shrink-0">{badge}</span> : null}
        </div>
        {emailLine ? (
          <span className={cn("truncate text-muted-foreground", styles.secondary)} title={emailLine}>
            {emailLine}
          </span>
        ) : null}
        {userIdLine ? (
          <span className={cn("truncate font-mono text-muted-foreground", styles.secondary)} title={userIdLine}>
            {userIdLine}
          </span>
        ) : null}
        {secondary ? (
          <div className={cn("min-w-0 text-muted-foreground", styles.secondary)}>{secondary}</div>
        ) : null}
      </div>
    </div>
  );
}
