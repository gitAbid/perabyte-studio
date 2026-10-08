"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Asset } from "@/lib/production/contracts";

const INPUT = "w-full rounded-[7px] border border-border-strong bg-raised px-2.5 py-2 text-[13px] text-ink focus:border-primary focus:outline-none";
const PRIMARY = "inline-flex items-center justify-center gap-1.5 rounded-[8px] px-3.5 py-2 text-[13px] font-semibold bg-primary-strong text-white hover:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed";
const SECONDARY = "inline-flex items-center justify-center gap-1.5 rounded-[8px] border border-border-strong bg-raised px-3.5 py-2 text-[13px] font-semibold text-ink hover:bg-surface disabled:opacity-50";

export function MusicVideoPanel({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [songs, setSongs] = useState<Asset[]>([]);
  const [songAssetId, setSongAssetId] = useState("");
  const [sectionCount, setSectionCount] = useState(6);
  const [direction, setDirection] = useState("");
  const [markers, setMarkers] = useState("");
  const [phase, setPhase] = useState<"idle" | "creating">("idle");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ storyRevisionId: string; sections: number } | null>(null);

  useEffect(() => {
    void fetch(`/api/production/projects/${projectId}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { assets?: Asset[] } | null) => {
        const audio = (payload?.assets ?? []).filter((asset) => asset.mime.startsWith("audio/") && asset.rightsStatus !== "unknown");
        setSongs(audio);
        if (audio[0]) setSongAssetId(audio[0].id);
      })
      .catch(() => setSongs([]));
  }, [projectId]);

  const parsedMarkers = useMemo(
    () => markers.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [label, seconds] = line.split("|").map((part) => part.trim());
      const duration = Number(seconds);
      return label && Number.isFinite(duration) && duration > 0 ? { label, durationMs: Math.round(duration * 1000) } : null;
    }).filter((entry): entry is { label: string; durationMs: number } => entry !== null),
    [markers],
  );

  async function create() {
    setPhase("creating");
    setError(null);
    try {
      const response = await fetch(`/api/production/projects/${projectId}/music-video`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          expectedStoryRevisionId: null,
          songAssetId,
          ...(parsedMarkers.length > 0 ? { sections: parsedMarkers } : { sectionCount }),
          ...(direction.trim() ? { visualDirection: direction.trim() } : {}),
          canonRevisionIds: [],
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const storyRevisionId = (payload as { storyRevisionId?: unknown } | null)?.storyRevisionId;
      if (response.ok && typeof storyRevisionId === "string") {
        setCreated({ storyRevisionId, sections: parsedMarkers.length > 0 ? parsedMarkers.length : sectionCount });
        return;
      }
      const message = (payload as { error?: { message?: unknown; action?: unknown } } | null)?.error;
      setError([typeof message?.message === "string" ? message.message : "The music video story could not be created.", typeof message?.action === "string" ? message.action : ""].filter(Boolean).join(" "));
    } catch {
      setError("The music video story could not be created: network error.");
    } finally {
      setPhase("idle");
    }
  }

  if (created) {
    return (
      <div className="mt-5 rounded-[12px] border border-success/40 bg-success-soft/60 p-5" data-testid="music-video.created">
        <p className="text-[14px] font-bold text-ink">Song sections are now story beats</p>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
          {created.sections} section(s) landed in the ordinary story chain — the storyboard, takes and first cut
          are the same shared path as any episode, timed to the song.
        </p>
        <div className="mt-3 flex gap-2">
          <button type="button" className={PRIMARY} onClick={() => router.push(`/production/${projectId}/story`)}>Open the story</button>
          <button type="button" className={SECONDARY} onClick={() => setCreated(null)}>Build another</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-5 flex flex-col gap-4" data-testid="music-video.form">
      <label className="block text-[12px] font-semibold text-muted" htmlFor="mvm-song">
        Song (import with rights declared — re-import from the audio page if it&apos;s missing or rights are undeclared)
      </label>
      <select id="mvm-song" className={INPUT} value={songAssetId} onChange={(event) => setSongAssetId(event.target.value)} data-testid="music-video.song">
        {songs.length === 0 && <option value="">No imported audio with declared rights yet</option>}
        {songs.map((song) => (
          <option key={song.id} value={song.id}>
            {song.id.slice(0, 8)} · {song.rightsStatus} · {song.audioSamples ? `${Math.round(song.audioSamples / 48_000)}s` : "unmeasured"}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-[12px] font-semibold text-muted" htmlFor="mvm-sections">
          Sections
          <input id="mvm-sections" type="number" min={1} max={50} className="w-20 rounded-[7px] border border-border bg-raised px-2 py-1.5 text-[12.5px] text-ink"
            value={sectionCount} onChange={(event) => setSectionCount(Math.max(1, Math.min(50, Number(event.target.value) || 1)))} data-testid="music-video.sections" />
        </label>
        <label className="flex-1 min-w-[220px] text-[12px] font-semibold text-muted">
          Visual direction (optional — becomes the first section&apos;s beat name)
          <input className={`${INPUT} mt-1`} value={direction} onChange={(event) => setDirection(event.target.value)} placeholder="dreamy neon city at night" data-testid="music-video.direction" />
        </label>
      </div>
      <label className="block text-[12px] font-semibold text-muted">
        Manual section markers (optional, one per line — replaces the even split: <code className="font-mono text-[11px]">Intro | 12.5</code>)
        <textarea className={`${INPUT} mt-1 font-mono`} rows={3} value={markers} onChange={(event) => setMarkers(event.target.value)} data-testid="music-video.markers" />
      </label>
      {error && <p role="alert" className="rounded-[8px] border border-danger/40 bg-danger-soft px-3 py-2 text-[12.5px] text-danger" data-testid="music-video.error">{error}</p>}
      <div>
        <button type="button" className={PRIMARY} disabled={!songAssetId || phase !== "idle"} onClick={() => void create()} data-testid="music-video.create">
          {phase === "creating" ? "Creating…" : "Create concept from sections"}
        </button>
      </div>
    </div>
  );
}
