"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Button, ConfirmDialog, Toggle, useToast } from "@/components/ui";
import {
  setUncensoredEnabled,
  useSettings,
} from "@/lib/repositories/settings.repository";

/**
 * Studio settings, opened from the header account menu. The Uncensored Mode
 * toggle here is the single gate for every uncensored feature (Character
 * Studio's Uncensored mode and NSFW image/video generation) — disabled by
 * default, with an explicit adult-content confirmation before it turns on.
 */
export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const { settings } = useSettings();
  const [confirmUncensored, setConfirmUncensored] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-[20px] border border-border bg-white p-6 shadow-lift">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-ink">Settings</h2>
            <p className="mt-0.5 text-[12.5px] text-muted">
              Studio-wide preferences, stored on this device.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="mt-5 space-y-5">
          <section>
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Content preferences
            </p>
            <div className="mt-3 rounded-[14px] border border-border bg-surface p-4">
              <Toggle
                label="Uncensored Mode"
                description="Unlocks the Character Studio Uncensored mode and adult (18+) image and video generation. Off by default."
                checked={settings.uncensoredEnabled}
                onChange={(next) => {
                  if (next) {
                    setConfirmUncensored(true);
                    return;
                  }
                  setUncensoredEnabled(false);
                  toast.push("Uncensored Mode disabled. Renders stay safe.");
                }}
              />
              {settings.uncensoredEnabled ? (
                <p className="mt-3 flex items-start gap-1.5 rounded-[10px] bg-[#fffbeb] px-2.5 py-2 text-[12px] font-medium text-warning">
                  <Icon name="alert" size={13} className="mt-0.5 shrink-0" />
                  Uncensored Mode is on. All content is intended for adults
                  (18+) only.
                </p>
              ) : (
                <p className="mt-3 text-[11.5px] leading-snug text-muted">
                  Enabling requires confirming you are 18+ and accept
                  adult-content generation.
                </p>
              )}
            </div>
          </section>

          <section>
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
              Generation models
            </p>
            <div className="mt-3 space-y-1.5 rounded-[14px] border border-border bg-surface p-4">
              {[
                ["Image model", settings.imageModel],
                ["Video model", settings.videoModel],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] text-muted">{label}</span>
                  <span className="text-right text-[12px] font-semibold text-ink">
                    {value ? value.split(":")[1] ?? value : "Default"}
                  </span>
                </div>
              ))}
              <p className="border-t border-border pt-2 text-[11.5px] leading-snug text-muted">
                Pick models from the Model badge in each prompt window — your
                choice is remembered per workspace.
              </p>
            </div>
          </section>
        </div>

        <div className="mt-5 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmUncensored}
        title="Enable Uncensored Mode?"
        body="This unlocks adult (18+) content, including explicit image, video and character generation. Characters are always adults. You confirm you are 18 or older."
        confirmLabel="Enable 18+ mode"
        onCancel={() => setConfirmUncensored(false)}
        onConfirm={() => {
          setUncensoredEnabled(true);
          setConfirmUncensored(false);
          toast.push("Uncensored Mode enabled.", "success");
        }}
      />
    </div>
  );
}
