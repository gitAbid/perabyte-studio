"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Icon, Logo } from "./Icon";
import { useToast } from "./ui";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/generate/image", label: "Generate" },
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
  const toast = useToast();

  return (
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
                className={`rounded-[10px] px-3.5 py-2 text-[13.5px] font-semibold transition-colors ${
                  active
                    ? "bg-primary-soft text-primary"
                    : "text-ink-soft hover:bg-surface-2 hover:text-ink"
                }`}
              >
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
                    toast.push("Account, billing and team settings arrive after the MVP.");
                  }}
                  className="block w-full rounded-[10px] px-2.5 py-2 text-left text-[13px] font-medium text-ink-soft hover:bg-surface-2"
                >
                  Account settings
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
              className={`block rounded-[10px] px-3 py-2.5 text-sm font-semibold ${
                isActive(pathname, item.href)
                  ? "bg-primary-soft text-primary"
                  : "text-ink-soft"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

const FOOTER_GROUPS = [
  {
    title: "Create",
    links: [
      { href: "/generate/image", label: "Solo Mode" },
      { href: "/story", label: "Story Mode" },
    ],
  },
  {
    title: "Library",
    links: [
      { href: "/history", label: "History" },
      { href: "/styleguide", label: "Style guide" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-[1280px] px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-8 md:flex-row md:justify-between">
          <div className="max-w-xs">
            <Logo size={26} />
            <p className="mt-3 text-[13px] leading-relaxed text-muted">
              An easy-to-use image and video generation studio for everyone.
              Create, explore, and bring your imagination to life — in seconds.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:gap-16">
            {FOOTER_GROUPS.map((group) => (
              <nav key={group.title} aria-label={`Footer — ${group.title}`}>
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
                  {group.title}
                </p>
                <ul className="mt-3 space-y-2">
                  {group.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="text-[13px] font-medium text-muted transition-colors hover:text-primary"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-muted">
            © {new Date().getFullYear()} PeraByte Studio. All rights reserved.
          </p>
          <p className="text-[12px] text-muted">
            Renders are AI-generated · Built for the web
          </p>
        </div>
      </div>
    </footer>
  );
}

/**
 * The generator and story screens are full-height workspaces, so the footer is
 * suppressed there and rendered on every content page.
 */
export function ConditionalFooter() {
  const pathname = usePathname();
  if (pathname?.startsWith("/generate") || pathname?.startsWith("/story")) {
    return null;
  }
  return <SiteFooter />;
}