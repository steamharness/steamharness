import type { ReactElement, ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function AvatarPreviewDialog({ src, alt, fallback, label, children }: {
  src?: string;
  alt?: string;
  fallback: ReactNode;
  label: string;
  children: ReactElement;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent aria-describedby={undefined} onClick={event => event.stopPropagation()}>
        <DialogHeader><DialogTitle>{label}</DialogTitle></DialogHeader>
        <Avatar className="mx-auto size-[min(24rem,calc(100vw-5rem),calc(100dvh-9rem))]">
          {src ? <AvatarImage src={src} alt={alt ?? label} /> : null}
          <AvatarFallback><span className="text-5xl font-semibold">{fallback}</span></AvatarFallback>
        </Avatar>
      </DialogContent>
    </Dialog>
  );
}
