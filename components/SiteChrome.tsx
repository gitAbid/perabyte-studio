"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon, Logo } from "./Icon";
import { SettingsDialog } from "./settings/SettingsDialog";

const NAV: { href: string; label: string; icon?: "character" }[] = [
  { href: "/", label: "Home" },
  { href: "/generate/image", label: "Generate" },
  { href: "/character", label: "Character", icon: "character" as const },
  { href: "/history", label: "History" },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/generate/image") return pathname.startsWith("/generate");
  return pathname.startsWith(href);
}

export function SiteHeader() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border bg-white/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-[1280px] items-center gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="PeraByte home" className="shrink-0">
          <Logo />
        </Link>

        <nav aria-label="Primary" className="mx-auto hidden items-center gap-1 sm:flex">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13.5px] font-semibold transition-colors ${
                  active
                    ? "bg-primary-soft text-primary"
                    : "text-ink-soft hover:bg-surface-2 hover:text-ink"
                }`}
              >
                {item.icon && <Icon name={item.icon} size={15} />}
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 sm:ml-0">
          <div className="relative hidden sm:block">
            <button
              type="button"
              aria-label="Account menu"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((v) => !v)}
              className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-white text-ink-soft transition-colors hover:border-muted hover:text-ink"
            >
              <Icon name="user" size={17} />
            </button>
            {accountOpen && (
              <div
                role="menu"
                className="absolute right-0 top-11 w-56 rounded-[14px] border border-border bg-white p-2 shadow-lift"
              >
                <p className="px-2.5 py-2 text-[12px] text-muted">
                  Signed in as <span className="font-semibold text-ink">Studio guest</span>
                </p>
                <div className="my-1 h-px bg-border" />
                <Link
                  href="/styleguide"
                  role="menuitem"
                  className="block rounded-[10px] px-2.5 py-2 text-[13px] font-medium text-ink-soft hover:bg-surface-2"
                  onClick={() => setAccountOpen(false)}
                >
                  Style guide
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAccountOpen(false);
                    setSettingsOpen(true);
                  }}
                  className="block w-full rounded-[10px] px-2.5 py-2 text-left text-[13px] font-medium text-ink-soft hover:bg-surface-2"
                >
                  Settings
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-white text-ink-soft sm:hidden"
          >
            <Icon name={menuOpen ? "close" : "menu"} size={18} />
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav
          aria-label="Mobile"
          className="border-t border-border bg-white px-4 py-3 sm:hidden"
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMenuOpen(false)}
              className={`flex items-center gap-2 rounded-[10px] px-3 py-2.5 text-sm font-semibold ${
                isActive(pathname, item.href)
                  ? "bg-primary-soft text-primary"
                  : "text-ink-soft"
              }`}
            >
              {item.icon && <Icon name={item.icon} size={16} />}
              {item.label}
            </Link>
          ))}
        </nav>
      )}
      </header>

      {/* Rendered outside the header: the header's backdrop-blur creates a
          containing block that would trap the dialog's fixed positioning. */}
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

const FOOTER_LINKS = [
  { href: "/generate/image", label: "Solo Mode" },
  { href: "/story", label: "Story Mode" },
  { href: "/character", label: "Character Studio" },
  { href: "/history", label: "History" },
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