"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, Logo, type IconName } from "./Icon";
import { RendersTray } from "./RendersTray";
import { THEME_STORAGE_KEY, type ThemePreference } from "@/lib/theme";

type NavItem = { href: string; label: string; icon: IconName };

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Make",
    items: [
      { href: "/generate/image", label: "Image studio", icon: "image" },
      { href: "/generate/video", label: "Motion studio", icon: "video" },
      { href: "/writer", label: "Story writer", icon: "pen" },
      { href: "/story", label: "Scene studio", icon: "story" },
    ],
  },
  {
    label: "Collect",
    items: [
      { href: "/images", label: "Renders", icon: "grid" },
      { href: "/stories", label: "Stories", icon: "layers" },
    ],
  },
  {
    label: "Build a world",
    items: [
      { href: "/character", label: "Characters", icon: "character" },
      { href: "/locations", label: "Places", icon: "home" },
    ],
  },
];

function isActive(pathname: string, href: string) {
  if (href === "/generate/image") return pathname === "/generate/image";
  if (href === "/generate/video") return pathname === "/generate/video";
  if (href === "/story") return pathname === "/story";
  if (href === "/images") return pathname.startsWith("/images") || pathname.startsWith("/results");
  return pathname.startsWith(href);
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const settingsActive = pathname.startsWith("/settings");

  return (
    <>
      <div className="flex h-[76px] shrink-0 items-center border-b border-border/70 px-5">
        <Link href="/" aria-label="PeraByte home" onClick={onNavigate}>
          <Logo size={32} />
        </Link>
      </div>

      <div className="px-4 pt-5">
        <Link
          href="/generate/image"
          onClick={onNavigate}
          className="group flex h-11 items-center justify-center gap-2 rounded-[10px] bg-primary-strong px-3 text-[13px] font-bold text-white shadow-[0_5px_16px_rgba(0,0,0,.2)] transition-colors hover:bg-primary-dark"
        >
          <Icon name="plus" size={17} />
          New creation
        </Link>
      </div>

      <nav aria-label="Primary" className="thin-scrollbar flex-1 overflow-x-hidden overflow-y-auto px-3 pb-3 pt-6">
        <div className="flex flex-col gap-6">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="mb-2 px-3 text-[9px] font-bold uppercase tracking-[0.2em] text-muted">
                {group.label}
              </p>
              <div className="flex flex-col gap-1">
                {group.items.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={`group flex h-10 items-center gap-3 rounded-[9px] px-3 text-[12.5px] font-medium transition-colors ${
                        active
                          ? "bg-primary-soft text-primary"
                          : "text-ink-soft hover:bg-surface-2 hover:text-ink"
                      }`}
                    >
                      <Icon name={item.icon} size={17} className="shrink-0 opacity-90" />
                      <span>{item.label}</span>
                      {active && <span className="ml-auto size-1.5 rounded-full bg-accent" />}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className="shrink-0 px-4 pb-4">
        <RendersTray />
        <div className="mt-3 flex items-center justify-between border-t border-border/70 pt-3">
          <Link
            href="/settings"
            onClick={onNavigate}
            aria-current={settingsActive ? "page" : undefined}
            className={`flex h-9 flex-1 items-center gap-2 rounded-[9px] px-2 text-[12px] font-semibold transition-colors ${
              settingsActive ? "bg-primary-soft text-primary" : "text-ink-soft hover:bg-surface-2 hover:text-ink"
            }`}
          >
            <Icon name="sliders" size={16} />
            Settings
          </Link>
          <ThemeToggle />
        </div>
        <div className="mt-3 flex items-center gap-2.5 px-1">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-[11px] font-bold text-white">G</span>
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[11.5px] font-semibold text-ink">Studio guest</span>
            <span className="block truncate text-[10px] text-muted">Local workspace</span>
          </span>
          <Icon name="more" size={17} className="ml-auto text-muted" />
        </div>
      </div>
    </>
  );
}

/** Fixed studio rail on desktop, with a matching slide-over on mobile. */
export function SiteSidebar() {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => setDrawerOpen(false), [pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  if (pathname === "/") return null;

  return (
    <>
      <aside className="workspace-sidebar sticky top-0 z-40 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-border/70 md:flex">
        <SidebarContent />
      </aside>

      <header className="workspace-sidebar sticky top-0 z-40 flex h-[58px] shrink-0 items-center border-b border-border/70 px-4 md:hidden">
        <Link href="/" aria-label="PeraByte home"><Logo size={29} /></Link>
        <span className="ml-3 border-l border-border pl-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Studio</span>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className="inline-flex size-9 items-center justify-center rounded-[9px] text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="menu" size={19} />
          </button>
        </div>
      </header>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
          />
          <aside className="workspace-sidebar absolute inset-y-0 left-0 flex w-[280px] flex-col border-r border-border/70 shadow-lift [animation:drawer-in_0.25s_ease-out]">
            <SidebarContent onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}

/** Theme toggle shared by the landing page and app navigation. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const toggle = () => {
    const root = document.documentElement;
    const next: ThemePreference = root.classList.contains("dark") ? "light" : "dark";
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
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-[9px] text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink ${className}`}
    >
      <Icon name="moon" size={17} className="dark:hidden" />
      <Icon name="sun" size={17} className="hidden dark:inline" />
    </button>
  );
}

/** Landing has its own story-driven footer; studio screens stay immersive. */
export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-2.5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-2.5">
          <Logo size={22} />
          <p className="text-[12px] text-muted">© {new Date().getFullYear()} PeraByte Studio · Renders are AI-generated</p>
        </div>
        <nav aria-label="Footer" className="-mx-1.5 flex flex-wrap items-center gap-0.5">
          {[
            ["/generate/image", "Image studio"], ["/writer", "Writer"], ["/story", "Scene studio"],
            ["/character", "Characters"], ["/images", "Renders"], ["/settings", "Settings"],
          ].map(([href, label]) => (
            <Link key={href} href={href} className="rounded-[8px] px-1.5 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink">{label}</Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}

export function ConditionalFooter() {
  return usePathname() === "/" ? <SiteFooter /> : null;
}
