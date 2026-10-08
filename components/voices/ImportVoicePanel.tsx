"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Icon } from "@/components/Icon";
import { Button, FieldShell, SelectField } from "@/components/ui";
import {
  describeUnsupportedVoiceFile,
  durationFromAudioSamples,
  type StoredVoice,
} from "@/lib/voices/read-model";

/**
 * Import-first voice import (spec 12, Creator Alpha). Talks to the studio's
 * only real audio import API — `POST /api/production/assets/import`
 * (multipart: file, source, rightsAttestation, rightsStatus) — the same
 * route the production audio workspace uses. No generation anywhere: the
 * panel never offers a "Generate" action, per spec 12 §8 (missing TTS
 * provider shows Import, not disabled fake generation).
 *
 * Outcomes, honestly labeled:
 * - 201 → the asset is checksum-stored in the media vault; the voice is
 *   mirrored into the localStorage seam so the library survives reloads.
 * - Server unreachable → the voice is kept as browser-local metadata with a
 *   plain warning; it is NOT claimed to be in the vault.
 * - Rejected (4xx/5xx) → nothing is imported; the route's message and a
 *   concrete hint are shown.
 */

/** The import route's audio size limit (vault AUDIO_LIMIT, 100 MB). */
const MAX_VOICE_BYTES = 100 * 1024 * 1024;

const RIGHTS_OPTIONS = [
  { value: "creator_attested", label: "I made this recording" },
  { value: "licensed", label: "I have a license for it" },
  { value: "public_domain", label: "It is public domain" },
] as const;

type Phase = "ready" | "importing" | "imported" | "failed";

type Notice = { tone: "success" | "warning" | "error"; message: string };

/** Parsed import-route response → the message the panel shows. */
function deriveImportOutcome(
  status: number | null,
  payload: unknown,
): { phase: "imported"; assetId: string; mime: string; byteSize: number | null; audioSamples: number | null; rightsStatus: string } | { phase: "failed"; message: string } {
  if (status !== null && status >= 200 && status < 300) {
    const asset =
      payload !== null && typeof payload === "object" && "asset" in payload
        ? (payload as { asset: unknown }).asset
        : null;
    if (asset && typeof asset === "object") {
      const row = asset as Record<string, unknown>;
      if (typeof row.id === "string" && typeof row.mime === "string") {
        return {
          phase: "imported",
          assetId: row.id,
          mime: row.mime,
          byteSize: typeof row.byteSize === "number" ? row.byteSize : null,
          audioSamples: typeof row.audioSamples === "number" ? row.audioSamples : null,
          rightsStatus: typeof row.rightsStatus === "string" ? row.rightsStatus : "unknown",
        };
      }
    }
    return { phase: "failed", message: "The studio stored the file but sent back a response this page couldn't read. Re-import the recording to add it to the library." };
  }
  if (status === 413) {
    return { phase: "failed", message: "That recording is over the 100 MB import limit. Trim or export it at a lower bitrate and try again." };
  }
  if (status !== null) {
    const envelope =
      payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "object"
        ? ((payload as { error: Record<string, unknown> }).error)
        : null;
    const detail = envelope && typeof envelope.message === "string" ? envelope.message : "The import was rejected.";
    return { phase: "failed", message: `${detail} Check the file and the source/rights fields, then retry.` };
  }
  return { phase: "failed", message: "NETWORK_UNREACHABLE" };
}

/** Probe an object URL's duration with the browser's audio decoder. */
function probeDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = new Audio();
    probe.preload = "metadata";
    const done = (value: number | null) => {
      probe.removeAttribute("src");
      resolve(value);
    };
    probe.onloadedmetadata = () => {
      done(Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : null);
    };
    probe.onerror = () => done(null);
    probe.src = url;
  });
}

export function ImportVoicePanel({
  onImported,
  onCancel,
}: {
  /** Called once per successful import (vault or browser-local). */
  onImported: (voice: StoredVoice, sessionUrl: string) => void;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [probedDuration, setProbedDuration] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [rightsStatus, setRightsStatus] = useState<(typeof RIGHTS_OPTIONS)[number]["value"]>("creator_attested");
  const [rightsAttestation, setRightsAttestation] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [notice, setNotice] = useState<Notice | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Keep the object URL (used for the duration probe and in-session
  // playback) in sync with the chosen file; revoke on replace/unmount.
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    let active = true;
    void probeDuration(url).then((duration) => {
      if (active) setProbedDuration(duration);
    });
    return () => {
      active = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    setFieldError(chosen ? describeUnsupportedVoiceFile({ name: chosen.name, type: chosen.type }) : null);
    setFile(chosen);
    setProbedDuration(null);
    setPhase("ready");
    setNotice(null);
    if (chosen && !name.trim()) {
      setName(chosen.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim());
    }
  }

  async function submit() {
    if (!file) {
      setFieldError("Choose a recording first — WAV, MP3, AAC, or FLAC.");
      return;
    }
    const unsupported = describeUnsupportedVoiceFile({ name: file.name, type: file.type });
    if (unsupported) {
      setFieldError(unsupported);
      return;
    }
    if (!name.trim()) {
      setFieldError("Give the voice a name so it is findable later.");
      return;
    }
    if (!source.trim() || !rightsAttestation.trim()) {
      setFieldError("Fill in where the recording came from and the rights attestation — the import route requires both.");
      return;
    }
    if (file.size > MAX_VOICE_BYTES) {
      setFieldError("That recording is over the 100 MB import limit.");
      return;
    }

    setPhase("importing");
    setNotice(null);
    const body = new FormData();
    body.append("file", file);
    body.append("source", source.trim());
    body.append("rightsAttestation", rightsAttestation.trim());
    body.append("rightsStatus", rightsStatus);

    let outcome: ReturnType<typeof deriveImportOutcome>;
    try {
      const response = await fetch("/api/production/assets/import", { method: "POST", body });
      const payload: unknown = await response.json().catch(() => undefined);
      outcome = deriveImportOutcome(response.status, payload);
    } catch {
      outcome = deriveImportOutcome(null, undefined);
    }

    if (outcome.phase === "imported") {
      const duration = outcome.audioSamples !== null
        ? durationFromAudioSamples(outcome.audioSamples)
        : probedDuration;
      onImported(
        {
          id: outcome.assetId,
          name: name.trim(),
          origin: "vault",
          mime: outcome.mime,
          byteSize: outcome.byteSize,
          durationSeconds: duration,
          rightsStatus: outcome.rightsStatus,
          source: source.trim(),
          importedAt: Date.now(),
        },
        previewUrl ?? "",
      );
      setPhase("imported");
      setNotice({ tone: "success", message: `"${name.trim()}" is in your voice library and stored in the media vault.` });
      resetForm();
      return;
    }

    if (outcome.message === "NETWORK_UNREACHABLE") {
      // Honest degradation: the vault could not take the bytes, so the
      // voice is metadata in this browser only — never claimed as stored.
      onImported(
        {
          id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          name: name.trim(),
          origin: "browser",
          mime: file.type || "audio/wav",
          byteSize: file.size,
          durationSeconds: probedDuration,
          rightsStatus,
          source: source.trim(),
          importedAt: Date.now(),
        },
        previewUrl ?? "",
      );
      setPhase("imported");
      setNotice({
        tone: "warning",
        message: "The local studio server couldn't be reached, so this voice is saved in this browser only. It won't be available to audio mixes until you re-import it while the server is running.",
      });
      resetForm();
      return;
    }

    setPhase("failed");
    setNotice({ tone: "error", message: outcome.message });
  }

  function resetForm() {
    setFile(null);
    setPreviewUrl(null);
    setProbedDuration(null);
    setName("");
    setSource("");
    setRightsAttestation("");
    setFieldError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const busy = phase === "importing";

  return (
    <section
      aria-label="Import a voice"
      data-testid="voices.import.panel"
      className="rounded-[12px] border border-border bg-raised p-5 shadow-card sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-bold text-ink">Import a voice</h2>
          <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted">
            Bring in a recording — a narration read, a line of dialogue, a vocal take. Your file
            uploads to the local studio media vault, checksum-stored, so later audio work can reuse
            the exact bytes. Voice generation isn&apos;t available yet; importing is how voices get in.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close import panel"
          data-testid="voices.import.close"
          className="rounded-[8px] p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Icon name="close" size={17} />
        </button>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <FieldShell
          label="Recording"
          htmlFor="voices-import-file"
          error={fieldError ?? undefined}
          hint="WAV, MP3, AAC, or FLAC — up to 100 MB. The studio re-verifies the format on upload."
        >
          <input
            ref={fileInputRef}
            id="voices-import-file"
            type="file"
            accept="audio/wav,audio/mpeg,audio/aac,audio/flac,.wav,.mp3,.aac,.flac"
            onChange={pickFile}
            disabled={busy}
            data-testid="voices.import.file"
            className="block w-full rounded-[8px] border border-border-strong bg-raised px-3 py-2.5 text-sm text-ink file:mr-3 file:rounded-[6px] file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-[12.5px] file:font-semibold file:text-ink hover:file:bg-surface focus:border-primary focus:outline-none disabled:opacity-55"
          />
        </FieldShell>

        <FieldShell label="Voice name" htmlFor="voices-import-name" hint="How the card reads in the library, e.g. “Luna — warm read”.">
          <input
            id="voices-import-name"
            type="text"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder="Luna — warm read"
            data-testid="voices.import.name"
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </FieldShell>

        <FieldShell label="Where it came from" htmlFor="voices-import-source" hint="Required by the import route — e.g. “Recorded at home”, “Studio session tape 4”.">
          <input
            id="voices-import-source"
            type="text"
            value={source}
            maxLength={1000}
            onChange={(e) => setSource(e.target.value)}
            disabled={busy}
            placeholder="Recorded at home"
            data-testid="voices.import.source"
            className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
          />
        </FieldShell>

        <SelectField
          label="Rights"
          disabled={busy}
          data-testid="voices.import.rights-status"
          value={rightsStatus}
          onChange={(e) => setRightsStatus(e.target.value as (typeof RIGHTS_OPTIONS)[number]["value"])}
        >
          {RIGHTS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>

        <div className="lg:col-span-2">
          <FieldShell
            label="Rights attestation"
            htmlFor="voices-import-attestation"
            hint="One line confirming you have the right to use this recording. Kept with the stored file."
          >
            <input
              id="voices-import-attestation"
              type="text"
              value={rightsAttestation}
              maxLength={4000}
              onChange={(e) => setRightsAttestation(e.target.value)}
              disabled={busy}
              placeholder="I recorded and own this performance."
              data-testid="voices.import.rights-attestation"
              className="h-11 w-full rounded-[8px] border border-border-strong bg-raised px-3.5 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none"
            />
          </FieldShell>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <Button
          onClick={submit}
          disabled={busy}
          loading={busy}
          icon="upload"
          data-testid="voices.import.submit"
        >
          {busy ? "Importing…" : "Import voice"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {notice && (
          <p
            role={notice.tone === "error" ? "alert" : "status"}
            data-testid="voices.import.status"
            className={`w-full text-[12.5px] leading-relaxed sm:w-auto sm:flex-1 ${
              notice.tone === "error"
                ? "text-danger"
                : notice.tone === "warning"
                  ? "text-warning"
                  : "text-success"
            }`}
          >
            {notice.message}
          </p>
        )}
      </div>
    </section>
  );
}
