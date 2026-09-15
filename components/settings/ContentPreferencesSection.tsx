"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { ConfirmDialog, Toggle, useToast } from "@/components/ui";
import {
  setUncensoredEnabled,
  useSettings,
} from "@/lib/repositories/settings.repository";

/** The single gate for every uncensored feature — disabled by default, with
 * an explicit adult-content confirmation before it turns on. */
export function ContentPreferencesSection() {
  const toast = useToast();
  const { settings } = useSettings();
  const [confirmUncensored, setConfirmUncensored] = useState(false);

  return (
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
            Uncensored Mode is on. All content is intended for adults (18+) only.
          </p>
        ) : (
          <p className="mt-3 text-[11.5px] leading-snug text-muted">
            Enabling requires confirming you are 18+ and accept adult-content
            generation.
          </p>
        )}
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
    </section>
  );
}