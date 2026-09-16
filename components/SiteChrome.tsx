"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, Logo, type IconName } from "./Icon";
import {
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

const SIDEBAR_STORAGE_KEY = "perabyte.sidebar-collapsed";

type NavItem = { href: string; label: string; icon: IconName };

const PRIMARY_NAV: NavItem[] = [
  { href: "/", label: "Home", icon: "home" },
  { href: "/generate/image", label: "Generate", icon: "sparkle" },
  { href: "/story", label: "Story", icon: "story" },
  { href: "/character", label: "Character", icon: "character" },
  { href: "/history", label: "History", icon: "history" },
];

const SECONDARY_NAV: NavItem[] = [
  { href: "/settings", label: "Settings", icon: "sliders" },
  { href: "/styleguide", label: "Style guide", icon: "layers" },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/generate/image") return pathname.startsWith("/generate");
  return pathname.startsWith(href);
}

/**
 * Shared sidebar inner layout, rendered inside the desktop capsule and the
 * mobile drawer. `collapsed` switches the desktop rail (icons + hover
 * tooltips); the drawer always renders the expanded form.
 */
function SidebarInner({
  collapsed,
  onNavigate,
  showCollapseToggle = true,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
  /** False in the mobile drawer, where collapse has no meaning. */
  showCollapseToggle?: boolean;
}) {
  const pathname = usePathname();

  const renderLink = (item: NavItem) => {
    const active = isActive(pathname, item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={`group relative flex h-11 items-center rounded-[12px] text-[13.5px] font-semibold transition-colors ${
          collapsed ? "justify-center px-0" : "gap-3 px-3"
        } ${
          active
            ? "bg-primary-soft text-primary"
            : "text-ink-soft hover:bg-surface-2 hover:text-ink"
        }`}
      >
        <Icon name={item.icon} size={19} className="shrink-0" />
        <span className={collapsed ? "sr-only" : "whitespace-nowrap"}>
          {item.label}
        </span>
        {collapsed && (
          <span
            role="tooltip"
            className="pointer-events-none absolute left-full top-1/2 z-50 ml-2.5 -translate-y-1/2 whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-[11.5px] font-semibold text-canvas opacity-0 shadow-lift transition-opacity duration-150 group-hover:opacity-100"
          >
            {item.label}
          </span>
        )}
      </Link>
    );
  };

  return (
    <>
      <div
        className={`flex h-16 shrink-0 items-center ${
          collapsed ? "justify-center px-2" : "px-5"
        }`}
      >
        <Link href="/" aria-label="PeraByte home">
          <Logo size={30} wordmark={!collapsed} />
        </Link>
      </div>

      <nav
        aria-label="Primary"
        className={`thin-scrollbar flex-1 pb-2 pt-1 ${
          // The collapsed rail must not clip its hover tooltips, which extend
          // past the capsule edge; it never needs to scroll anyway.
          collapsed ? "overflow-visible px-3" : "overflow-x-hidden overflow-y-auto px-4"
        }`}
      >
        <div className="flex flex-col gap-1.5">{PRIMARY_NAV.map(renderLink)}</div>

        <div
          className={`my-4 h-px bg-border ${
            collapsed ? "mx-auto w-8" : "mx-2"
          }`}
        />

        <div className="flex flex-col gap-1.5">
          {SECONDARY_NAV.map(renderLink)}
        </div>
      </nav>

      <SidebarFoot
        collapsed={collapsed}
        showCollapseToggle={showCollapseToggle}
      />
    </>
  );
}

function SidebarFoot({
  collapsed,
  showCollapseToggle,
}: {
  collapsed: boolean;
  showCollapseToggle: boolean;
}) {
  return (
    <div
      className={`shrink-0 pb-4 ${
        collapsed ? "flex flex-col items-center gap-2 px-3" : "px-4"
      }`}
    >
      <div
        className={`flex items-center gap-1.5 ${
          collapsed ? "flex-col" : "justify-between"
        }`}
      >
        <ThemeToggle />
        {showCollapseToggle && <CollapseToggle collapsed={collapsed} />}
      </div>

      <div
        className={`flex items-center gap-2.5 ${
          collapsed ? "mt-2 flex-col" : "mt-3 w-full"
        }`}
      >
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-accent text-[13px] font-bold text-white"
        >
          G
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px] font-semibold text-ink">
              Studio guest
            </span>
            <span className="block truncate text-[11.5px] text-muted">
              Local workspace
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Sun/moon pair swapped purely by CSS — no hydration flash. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const toggle = () => {
    const root = document.documentElement;
    const next: ThemePreference = root.classList.contains("dark")
      ? "light"
      : "dark";
    root.classList.toggle("dark", next === "dark");
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage unavailable — theme still applies for this session */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      title="Toggle dark mode"
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink ${className}`}
    >
      <Icon name="moon" size={18} className="dark:hidden" />
      <Icon name="sun" size={18} className="hidden dark:inline" />
    </button>
  );
}

function CollapseToggle({ collapsed }: { collapsed: boolean }) {
  const toggle = () => {
    const next = !collapsed;
    try {
      window.localStorage.setItem(
        SIDEBAR_STORAGE_KEY,
        next ? "collapsed" : "expanded",
      );
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new Event("perabyte:sidebar"));
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
    >
      <Icon
        name="chevrons-left"
        size={18}
        className={`transition-transform duration-300 ${
          collapsed ? "rotate-180" : ""
        }`}
      />
    </button>
  );
}

/**
 * Floating capsule sidebar: icon rail on desktop (collapsible, hover
 * tooltips), slim top bar + slide-over drawer on mobile.
 */
export function SiteSidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const sync = () => {
      try {
        setCollapsed(
          window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "collapsed",
        );
      } catch {
        /* ignore */
      }
    };
    sync();
    window.addEventListener("perabyte:sidebar", sync);
    return () => window.removeEventListener("perabyte:sidebar", sync);
  }, []);

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <>
      {/* Desktop capsule */}
      <aside
        className={`sticky top-3 z-40 hidden h-[calc(100dvh-1.5rem)] shrink-0 flex-col rounded-xl border border-border bg-raised shadow-card transition-[width] duration-300 ease-in-out md:ml-3 md:flex ${
          collapsed ? "w-[76px]" : "w-[248px]"
        }`}
      >
        <SidebarInner collapsed={collapsed} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-canvas/90 px-3 backdrop-blur-md md:hidden">
        <Link href="/" aria-label="PeraByte home">
          <Logo size={26} />
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className="inline-flex size-9 items-center justify-center rounded-[10px] text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="menu" size={19} />
          </button>
        </div>
      </header>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          />
          <aside className="absolute inset-y-0 left-0 flex w-[264px] flex-col rounded-xl border border-border bg-raised shadow-lift [animation:drawer-in_0.25s_ease-out]">
            <SidebarInner
              collapsed={false}
              showCollapseToggle={false}
              onNavigate={() => setDrawerOpen(false)}
            />
          </aside>
        </div>
      )}
    </>
  );
}

const FOOTER_LINKS = [
  { href: "/generate/image", label: "Solo Mode" },
  { href: "/story", label: "Story Mode" },
  { href: "/character", label: "Character Studio" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings" },
  { href: "/styleguide", label: "Style guide" },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-2.5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2.5">
          <Logo size={22} />
          <p className="text-[12px] text-muted">
            © {new Date().getFullYear()} PeraByte Studio · Renders are
            AI-generated
          </p>
        </div>
        <nav
          aria-label="Footer"
          className="-mx-1.5 flex flex-wrap items-center gap-0.5"
        >
          {FOOTER_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-[8px] px-1.5 py-1 text-[12.5px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}

/**
 * The generator, story and character screens are full-height workspaces, so
 * the footer is suppressed there and rendered on every content page.
 */
export function ConditionalFooter() {
  const pathname = usePathname();
  if (
    pathname?.startsWith("/generate") ||
    pathname?.startsWith("/story") ||
    pathname?.startsWith("/character")
  ) {
    return null;
  }
  return <SiteFooter />;
}
