import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, ChevronsUpDown, FolderKanban, LogOut, ScrollText, Settings, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { useTranslation } from "@steamharness/i18n/react";
import type { ServerWebResourceKey } from "@steamharness/i18n";
import { cn } from "@/lib/utils";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { UserIdentity } from "@/components/UserIdentity";

interface ConsoleNavItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  onClick?: () => void;
  active?: boolean;
  children?: ConsoleNavItem[];
}

interface PrincipalMenuAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

interface AppLayoutProps {
  principalLabel?: string;
  principalEmail?: string;
  principalAvatarUrl?: string;
  principalMenuActions?: PrincipalMenuAction[];
  currentLabel: string;
  breadcrumbs?: Array<{ label: string; onClick?: () => void }>;
  headerExtras?: ReactNode;
  secondaryActions?: Array<{
    label: string; icon: LucideIcon; onClick: () => void;
    variant?: "default" | "outline"; disabled?: boolean; loading?: boolean;
  }>;
  navItems: ConsoleNavItem[];
  navGroups?: Array<{ id: string; label: string; items: ConsoleNavItem[] }>;
  navigationLabel?: string;
  onBrandClick: () => void;
  onLogout: () => void;
  children: ReactNode;
}

function NavigationGroup({ items, label }: { items: ConsoleNavItem[]; label?: string }) {
  const { setOpenMobile } = useSidebar();
  const select = (action?: () => void) => { action?.(); setOpenMobile(false); };
  return (
    <SidebarGroup>
      {label ? <SidebarGroupLabel className="truncate" title={label}>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(item => <NavigationItem key={item.id} item={item} onSelect={select} />)}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function BrandMenuButton({ onClick }: { onClick: () => void }) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuButton onClick={() => { onClick(); setOpenMobile(false); }}>
      <img src="/brand/steamharness-icon.svg" alt="" className="size-5" />
      <span className="text-base font-semibold">SteamHarness</span>
    </SidebarMenuButton>
  );
}

function activeNavigationId(item: ConsoleNavItem): string | undefined {
  return item.children?.length
    ? item.children.map(activeNavigationId).find(Boolean)
    : item.active ? item.id : undefined;
}

function NavigationItem({ item, nested = false, onSelect }: {
  item: ConsoleNavItem;
  nested?: boolean;
  onSelect: (action?: () => void) => void;
}) {
  const hasChildren = Boolean(item.children?.length);
  const activeChildId = hasChildren ? activeNavigationId(item) : undefined;
  const [open, setOpen] = useState(Boolean(activeChildId));
  useEffect(() => { if (activeChildId) setOpen(true); }, [activeChildId]);
  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem;
  const active = !hasChildren && item.active;
  const onClick = hasChildren ? undefined : () => onSelect(item.onClick);
  const content = <>
    {item.icon ? <item.icon /> : null}
    <span className="min-w-0 flex-1 truncate">{item.label}</span>
    {hasChildren ? <ChevronRight className={cn("ml-auto transition-transform", open && "rotate-90")} /> : null}
  </>;
  const button = nested ? (
    <SidebarMenuSubButton asChild className="w-full text-left" isActive={active} aria-current={active ? "page" : undefined} title={item.label}>
      <button type="button" onClick={onClick}>{content}</button>
    </SidebarMenuSubButton>
  ) : (
    <SidebarMenuButton type="button" tooltip={item.label} isActive={active} aria-current={active ? "page" : undefined} onClick={onClick}>
      {content}
    </SidebarMenuButton>
  );
  if (!hasChildren) return <Item>{button}</Item>;

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <Item>
        <CollapsibleTrigger asChild>{button}</CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.children?.map(child => <NavigationItem key={child.id} item={child} nested onSelect={onSelect} />)}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Item>
    </Collapsible>
  );
}

export function AppLayout({
  principalLabel, principalEmail, principalAvatarUrl, principalMenuActions,
  currentLabel, breadcrumbs, headerExtras, secondaryActions, navItems, navGroups, navigationLabel,
  onBrandClick, onLogout, children,
}: AppLayoutProps) {
  const { t } = useTranslation("serverWeb");
  const trail = breadcrumbs?.length ? breadcrumbs : [{ label: currentLabel }];
  return (
    <SidebarProvider className="h-svh min-h-0" style={{ "--sidebar-width": "calc(var(--spacing) * 72)", "--header-height": "calc(var(--spacing) * 12)" } as CSSProperties}>
      <Sidebar collapsible="offcanvas" variant="inset">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem><BrandMenuButton onClick={onBrandClick} /></SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent role="navigation" aria-label={t("appLayoutMainNavAria")}>
          {navGroups
            ? navGroups.map(group => <NavigationGroup key={group.id} items={group.items} label={group.label} />)
            : <NavigationGroup items={navItems} label={navigationLabel} />}
        </SidebarContent>
        <SidebarFooter>
          <AccountMenu label={principalLabel} email={principalEmail} avatarUrl={principalAvatarUrl}
            actions={principalMenuActions} onLogout={onLogout} />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 overflow-hidden">
        <header data-slot="console-header" className="flex min-h-(--header-height) shrink-0 items-center gap-2 border-b">
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 px-4 py-2 lg:px-6">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
            <Breadcrumb className="min-w-0 flex-1">
              <BreadcrumbList className="flex-nowrap">
                {trail.map((item, index) => (
                  <Fragment key={`${item.label}-${index}`}>
                    <BreadcrumbItem className={cn("min-w-0", index < trail.length - 1 && "hidden md:inline-flex")}>
                      {index === trail.length - 1 ? (
                        <BreadcrumbPage className="truncate" title={item.label}>{item.label}</BreadcrumbPage>
                      ) : item.onClick ? (
                        <BreadcrumbLink asChild><button type="button" onClick={item.onClick} className="truncate" title={item.label}>{item.label}</button></BreadcrumbLink>
                      ) : <span className="truncate" title={item.label}>{item.label}</span>}
                    </BreadcrumbItem>
                    {index < trail.length - 1 ? <BreadcrumbSeparator className="hidden md:block" /> : null}
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {headerExtras}
              {secondaryActions?.map(action => (
                <Button key={action.label} size="sm" variant={action.variant ?? "outline"}
                  aria-label={action.label} title={action.label} onClick={action.onClick} disabled={action.disabled}>
                  <action.icon data-icon="inline-start" className={cn(action.loading && "animate-spin")} />
                  <span className="hidden sm:inline">{action.label}</span>
                </Button>
              ))}
            </div>
          </div>
        </header>
        <div className="@container/main flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AccountMenu({ label, email, avatarUrl, actions, onLogout }: {
  label?: string; email?: string; avatarUrl?: string; actions?: PrincipalMenuAction[]; onLogout: () => void;
}) {
  const { t } = useTranslation("serverWeb");
  const { isMobile, setOpenMobile } = useSidebar();
  const select = (action: () => void) => { action(); setOpenMobile(false); };
  return (
    <SidebarMenu><SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
            <UserIdentity user={{ displayName: label, email, avatarUrl }} fallbackLabel={t("appLayoutAccountMenuLabel")}
              size="sm" avatarShape="rounded" showUserId={false} className="min-w-0 flex-1" />
            <ChevronsUpDown className="ml-auto size-4" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("appLayoutAccountMenuLabel")}</DropdownMenuLabel>
            {actions?.map(action => <DropdownMenuItem key={action.label} onSelect={() => select(action.onSelect)}><action.icon />{action.label}</DropdownMenuItem>)}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => select(onLogout)}><LogOut />{t("appLayoutLogout")}</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem></SidebarMenu>
  );
}

export const CONSOLE_NAV_ICONS = { projects: FolderKanban, settings: Settings, admin: ShieldCheck } as const satisfies Record<string, LucideIcon>;

export const ADMIN_TAB_META: Record<import("../state").AdminTab, { labelKey: ServerWebResourceKey; icon: LucideIcon }> = {
  users: { labelKey: "adminTabUsers", icon: Users },
  roles: { labelKey: "adminTabRoles", icon: ShieldCheck },
  audit: { labelKey: "adminTabAudit", icon: ScrollText },
};
