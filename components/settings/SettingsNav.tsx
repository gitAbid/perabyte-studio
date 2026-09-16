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

/** Second-level settings nav: sticky rail beside the content on md+, a
 * horizontally scrollable chip row above it on mobile. */
export function SettingsNav({
  section,
  onSelect,
}: {
  section: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="w-full min-w-0 self-start md:sticky md:shrink-0 md:top-8 md:w-[188px]"
    >
      <div className="flex gap-1.5 overflow-x-auto pb-1 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
        {SECTIONS.map((s) => {
          const active = s.id === section;
          return (
            <button
              key={s.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(s.id)}
              className={`flex shrink-0 items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] font-semibold transition-colors md:w-full ${
                active
                  ? "bg-primary-soft text-primary"
                  : "text-ink-soft hover:bg-surface-2"
              }`}
            >
              <Icon name={s.icon} size={15} />
              <span>{s.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
