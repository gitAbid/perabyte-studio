"use client";

import { Icon, type IconName } from "@/components/Icon";

const SECTIONS = [
  { id: "general", label: "General", icon: "sliders" },
  { id: "providers", label: "Providers", icon: "chip" },
  { id: "models", label: "Models", icon: "grid" },
  { id: "advanced", label: "Advanced", icon: "clock" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

export { SECTIONS };
export type SettingsSectionId = (typeof SECTIONS)[number]["id"];

export function isSettingsSection(
  value: string | null,
): value is SettingsSectionId {
  return SECTIONS.some((s) => s.id === value);
}

/** Settings sections use a horizontal index so controls keep the full canvas. */
export function SettingsNav({
  section,
  onSelect,
}: {
  section: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
}) {
  return (
    <nav aria-label="Settings sections" className="w-full min-w-0 overflow-x-auto border-b border-border">
      <div className="flex min-w-max items-stretch gap-5">
        {SECTIONS.map((s) => {
          const active = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(s.id)}
              className={`relative flex shrink-0 items-center gap-2 border-b-2 px-1 pb-3 pt-2 text-[11px] font-bold uppercase tracking-[0.1em] transition-colors ${
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon name={s.icon} size={14} />
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
