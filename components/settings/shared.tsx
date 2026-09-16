"use client";

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/Icon";

/** Shared header + container for a settings section pane. */
export function SectionShell({
  icon,
  title,
  description,
  children,
}: {
  icon: IconName;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="animate-fade-up">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
          <Icon name={icon} size={17} />
        </span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold text-ink">{title}</h2>
          <p className="text-[12.5px] text-muted">{description}</p>
        </div>
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}
