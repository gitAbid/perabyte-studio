"use client";

import Link from "next/link";
import { Icon } from "@/components/Icon";

/** Dropdown row used by the library card menus (History's pattern). */
export function MenuItem({
  icon,
  label,
  href,
  onSelect,
  onDone,
  tone = "default",
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  href?: string;
  onSelect?: () => void;
  onDone?: () => void;
  tone?: "default" | "danger";
}) {
  const className = `flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] font-medium transition-colors ${
    tone === "danger"
      ? "text-danger hover:bg-danger-soft"
      : "text-ink-soft hover:bg-surface-2"
  }`;
  if (href) {
    return (
      <Link href={href} role="menuitem" className={className} onClick={onDone}>
        <Icon name={icon} size={15} />
        {label}
      </Link>
    );
  }
  return (
    <button type="button" role="menuitem" className={className} onClick={onSelect}>
      <Icon name={icon} size={15} />
      {label}
    </button>
  );
}
