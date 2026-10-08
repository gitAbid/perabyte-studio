"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge, Button, formatDate } from "@/components/ui";
import {
  formatRightsStatus,
  formatVoiceByteSize,
  formatVoiceDuration,
  formatVoiceKind,
  type VoiceView,
} from "@/lib/voices/read-model";

/**
 * One voice card (spec 12 §2: name, character binding, duration, play).
 *
 * Playback honesty: vault audio bytes have no media-serving HTTP route yet
 * (export download is the only byte route in the studio), so a card is
 * playable only inside the tab that imported the file — the session object
 * URL. Any other visit disables Play and says why instead of pretending.
 * Removing the preview is a bookkeeping delete: the vault object and its
 * production-store row stay until a delete route exists (documented gap).
 */
export function VoiceCard({
  voice,
  sessionUrl,
  onAssign,
  onRemove,
}: {
  voice: VoiceView;
  /** Object URL from the importing tab; null on any later visit. */
  sessionUrl: string | null;
  onAssign: () => void;
  onRemove: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  // A replaced/revoked URL must stop playback, not error mid-air.
  useEffect(() => {
    if (!sessionUrl && audioRef.current) {
      audioRef.current.pause();
      setPlaying(false);
    }
  }, [sessionUrl]);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !sessionUrl) return;
    if (playing) {
      audio.pause();
      return;
    }
    void audio.play().catch(() => setPlaying(false));
  }

  const originLabel = voice.origin === "vault" ? "In media vault" : "This browser only";

  return (
    <article
      data-testid={`voices.voice-card.${voice.id}`}
      className="flex flex-col rounded-[12px] border border-border bg-raised p-5 shadow-card transition-colors hover:border-border-strong"
    >
      <div className="flex items-start gap-3.5">
        <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
          <Icon name="volume" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14.5px] font-bold leading-snug text-ink" title={voice.name}>
            {voice.name}
          </h3>
          <p className="mt-0.5 text-[12px] text-muted">
            {formatVoiceKind(voice.mime)} · {formatVoiceDuration(voice.durationSeconds)}
            {voice.byteSize !== null ? ` · ${formatVoiceByteSize(voice.byteSize)}` : ""}
          </p>
        </div>
        {voice.boundTo?.locked ? (
          <span data-testid={`voices.voice-card.${voice.id}.locked-badge`}>
            <Badge tone="primary">
              <Icon name="lock" size={11} aria-hidden="true" />
              Locked
            </Badge>
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
        <span className="rounded-[5px] bg-surface-2 px-2 py-1 uppercase tracking-[0.06em] text-ink-soft">
          {originLabel}
        </span>
        <span className="rounded-[5px] bg-surface-2 px-2 py-1 text-ink-soft">
          {formatRightsStatus(voice.rightsStatus)}
        </span>
      </div>

      {voice.boundTo ? (
        <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-ink-soft">
          <Icon name="character" size={14} className="shrink-0 text-muted" />
          Bound to <span className="font-semibold text-ink">{voice.boundTo.characterName}</span>
          {!voice.boundTo.locked && <span className="text-muted">(unlocked)</span>}
        </p>
      ) : (
        <p className="mt-3 text-[12.5px] text-muted">Not bound to a character yet.</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button
          variant="secondary"
          size="sm"
          icon={playing ? "pause" : "play"}
          onClick={togglePlay}
          disabled={!sessionUrl}
          title={
            sessionUrl
              ? undefined
              : "Preview lives in the tab that imported the file — re-import to hear it here."
          }
          data-testid={`voices.voice-card.${voice.id}.play`}
        >
          {playing ? "Pause" : "Play"}
        </Button>
        <Button variant="ghost" size="sm" icon="character" onClick={onAssign} data-testid={`voices.voice-card.${voice.id}.assign`}>
          {voice.boundTo ? "Change binding" : "Assign"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="trash"
          className="ml-auto text-muted hover:text-danger"
          onClick={onRemove}
          data-testid={`voices.voice-card.${voice.id}.remove`}
        >
          <span className="sr-only sm:not-sr-only">Remove</span>
        </Button>
      </div>

      {sessionUrl ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- voice previews are raw takes with no transcript track yet
        <audio ref={audioRef} src={sessionUrl} preload="none" onEnded={() => setPlaying(false)} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} className="hidden" />
      ) : null}

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        Imported {formatDate(voice.importedAt)} · {voice.source}
        {!sessionUrl && " · Preview available after re-import"}
      </p>
    </article>
  );
}
