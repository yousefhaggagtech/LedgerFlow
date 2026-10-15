"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowUpRight, Building2, ChartNoAxesCombined, ChevronDown, Files,
  Landmark, Menu, PanelLeftClose, PanelLeftOpen, Receipt, Settings,
  Sparkles, Wallet, type LucideIcon
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Section = { label: string; icon: LucideIcon };
const workspaceSections: readonly Section[] = [
  { label: "Sales", icon: ArrowUpRight },
  { label: "Expenses", icon: Receipt },
  { label: "Banking", icon: Landmark },
  { label: "Reports", icon: ChartNoAxesCombined }
];
const toolSections: readonly Section[] = [
  { label: "Documents", icon: Files },
  { label: "AI Assistant", icon: Sparkles }
];
const settingsSection: Section = { label: "Settings", icon: Settings };

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className={cn("flex h-navbar shrink-0 items-center gap-3 px-5", collapsed && "justify-center px-0")}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Wallet className="size-4" aria-hidden="true" />
      </span>
      <span className={cn("text-lg font-semibold tracking-tight text-foreground", collapsed && "sr-only")}>
        LedgerFlow
      </span>
    </div>
  );
}

function NavigationLink({ section, active, collapsed, onSelect }: {
  section: Section;
  active: string;
  collapsed: boolean;
  onSelect: (label: string) => void;
}) {
  const Icon = section.icon;
  const link = (
    <a
      href={`#${section.label.toLowerCase().replaceAll(" ", "-")}`}
      aria-current={active === section.label ? "page" : undefined}
      onClick={(event) => {
        // Local selection previews the shell until feature routes are introduced.
        event.preventDefault();
        onSelect(section.label);
      }}
      className={cn(
        "relative flex h-nav-item items-center gap-3 rounded-md px-3 font-medium text-sidebar-foreground hover:bg-muted hover:text-foreground",
        "aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground",
        "before:absolute before:inset-y-3 before:left-0 before:w-nav-indicator before:rounded-full aria-[current=page]:before:bg-primary",
        collapsed && "justify-center px-0"
      )}
    >
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      <span className={cn(collapsed && "sr-only")}>{section.label}</span>
    </a>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      {collapsed && <TooltipContent side="right" className="ml-2">{section.label}</TooltipContent>}
    </Tooltip>
  );
}

function SidebarNavigation({ active, collapsed = false, onSelect, id }: {
  active: string;
  collapsed?: boolean;
  onSelect: (label: string) => void;
  id: string;
}) {
  const renderLink = (section: Section) => (
    <li key={section.label}>
      <NavigationLink section={section} active={active} collapsed={collapsed} onSelect={onSelect} />
    </li>
  );
  return (
    <nav id={id} aria-label="Main navigation" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-5">
      <div className="space-y-2">
        <p className={cn("px-3 pb-1 text-xs font-medium text-muted-foreground", collapsed && "sr-only")}>Workspace</p>
        <ul className="space-y-1">{workspaceSections.map(renderLink)}</ul>
      </div>
      <div className="mt-6 space-y-2">
        <p className={cn("px-3 pb-1 text-xs font-medium text-muted-foreground", collapsed && "sr-only")}>Tools</p>
        <ul className="space-y-1">{toolSections.map(renderLink)}</ul>
      </div>
      <ul className="mt-auto pt-8">{renderLink(settingsSection)}</ul>
    </nav>
  );
}

function ProfileMenu() {
  const [notice, setNotice] = useState("");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-nav-item gap-2 px-2" aria-label="Open user menu">
          <Avatar><AvatarFallback className="bg-secondary text-xs font-semibold text-secondary-foreground">DU</AvatarFallback></Avatar>
          <span className="hidden text-left sm:block">
            <span className="block text-sm font-medium">Demo User</span>
            <span className="block text-xs font-normal text-muted-foreground">Personal profile</span>
          </span>
          <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-profile-menu">
        <DropdownMenuLabel>
          <p>Demo User</p>
          <p className="mt-1 text-xs font-normal text-muted-foreground">Profile preview</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setNotice("Your profile will be available in a future update."); }}>My profile</DropdownMenuItem>
        <DropdownMenuItem onSelect={(event) => { event.preventDefault(); setNotice("Account settings will be available in a future update."); }}>Account settings</DropdownMenuItem>
        <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{notice || "These actions are placeholders."}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [active, setActive] = useState(workspaceSections[0]?.label ?? "Sales");

  useEffect(() => {
    // Read the same breakpoint used by Tailwind to avoid a second responsive rule.
    const breakpoint = getComputedStyle(document.documentElement).getPropertyValue("--breakpoint-md").trim();
    const desktop = window.matchMedia(`(min-width: ${breakpoint})`);
    const closeMobileOnDesktop = () => { if (desktop.matches) setMobileOpen(false); };
    desktop.addEventListener("change", closeMobileOnDesktop);
    return () => desktop.removeEventListener("change", closeMobileOnDesktop);
  }, []);

  const toggle = (
    <Button
      variant="ghost"
      size={collapsed ? "icon" : "default"}
      className={cn("h-nav-item text-muted-foreground", !collapsed && "w-full justify-start px-3")}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-controls="desktop-navigation"
      aria-expanded={!collapsed}
      onClick={() => setCollapsed((value) => !value)}
    >
      {collapsed ? <PanelLeftOpen className="size-5" aria-hidden="true" /> : <PanelLeftClose className="size-5" aria-hidden="true" />}
      {!collapsed && <span>Collapse sidebar</span>}
    </Button>
  );

  return (
    <TooltipProvider delayDuration={250}>
      <a href="#main-content" className="sr-only z-50 rounded-md bg-card px-4 py-3 focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <div className="flex min-h-dvh">
        <aside
          aria-label="Sidebar"
          data-collapsed={collapsed}
          className={cn("sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex", collapsed ? "w-sidebar-collapsed" : "w-sidebar-expanded")}
        >
          <Brand collapsed={collapsed} />
          <Separator />
          <SidebarNavigation id="desktop-navigation" active={active} collapsed={collapsed} onSelect={setActive} />
          <div className="border-t p-2">
            {/* A stable trigger keeps keyboard focus when the sidebar changes width. */}
            <Tooltip>
              <TooltipTrigger asChild>{toggle}</TooltipTrigger>
              {collapsed && <TooltipContent side="right" className="ml-2">Expand sidebar</TooltipContent>}
            </Tooltip>
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <header className="sticky top-0 z-30 flex h-navbar shrink-0 items-center justify-between gap-3 border-b bg-card px-4 md:px-6 lg:px-8">
              <div className="flex min-w-0 items-center gap-3">
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="shrink-0 md:hidden" aria-label="Open navigation">
                    <Menu className="size-5" aria-hidden="true" />
                  </Button>
                </SheetTrigger>
                <div className="min-w-0 space-y-1">
                  <p className="flex items-center gap-2 truncate font-semibold">
                    <Building2 className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
                    Acme Studio
                  </p>
                  <Breadcrumb aria-label="Breadcrumb">
                    <BreadcrumbList className="gap-1 text-xs sm:gap-1">
                      <BreadcrumbItem>Workspace</BreadcrumbItem>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem><BreadcrumbPage className="text-xs">{active}</BreadcrumbPage></BreadcrumbItem>
                    </BreadcrumbList>
                  </Breadcrumb>
                </div>
              </div>
              <ProfileMenu />
            </header>
            <SheetContent side="left" showCloseButton={false} className="gap-0 p-0">
              <SheetTitle className="sr-only">LedgerFlow navigation</SheetTitle>
              <SheetDescription className="sr-only">Choose a workspace section. Sections are previews.</SheetDescription>
              <Brand />
              <Separator />
              <SidebarNavigation id="mobile-navigation" active={active} onSelect={(label) => { setActive(label); setMobileOpen(false); }} />
              <div className="border-t p-3">
                <SheetClose asChild><Button variant="outline" className="w-full">Close navigation</Button></SheetClose>
              </div>
            </SheetContent>
          </Sheet>
          <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-content flex-1 p-5 md:p-6 lg:p-8">
            {children}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
