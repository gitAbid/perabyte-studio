import type { Metadata } from "next";
import { EmptyState } from "@/components/production/primitives/empty-state";
import { Icon } from "@/components/Icon";
import { VoiceLibrary } from "@/components/voices/VoiceLibrary";
import { listCharacters } from "@/lib/services/characters.service";
import { ensureRecordsSeeded, listRecords } from "@/lib/services/records.service";
import {
  characterRefFrom,
  selectHistoryAudioAssets,
  type HistoryAudioAsset,
  type VoiceCharacterRef,
} from "@/lib/voices/read-model";

export const metadata: Metadata = {
  title: "Voices",
  description:
    "Your voice library: import recordings, bind them to characters, and lock each binding so narration and dialogue stay consistent once audio generation arrives.",
};

/**
 * /voices (feature spec 12 — Voice & Audio Studio, Creator Alpha
 * "import-first" slice; frozen route table C11).
 *
 * Server component: reads the canon cast and the History record store
 * through the SAME services the existing APIs use (read-only — no provider
 * calls, no TTS anywhere) and hands narrow, serializable props to the
 * client library. All voice state beyond that lives in the documented
 * browser-local seam (localStorage `perabyte.voices.v1`); server-side voice
 * persistence is post-Alpha per the spec.
 *
 * Dynamic render: the stores are fs-backed JSON that change outside Next's
 * knowledge, so every request re-reads.
 */
export const dynamic = "force-dynamic";

export default function VoicesPage() {
  let characters: VoiceCharacterRef[];
  let charactersError: string | null = null;
  let historyAssets: HistoryAudioAsset[];
  try {
    // Same first-read demo seeding /api/assets performs, so /library and
    // /voices agree on what exists.
    ensureRecordsSeeded();
    characters = listCharacters().map(characterRefFrom);
    // History audio rows are a forward-compat seam: the store's row parser
    // admits only image/video/story today, so this is [] until the store
    // grows an audio kind (lib/voices/read-model.ts docblock).
    historyAssets = selectHistoryAudioAssets(listRecords());
  } catch {
    // A corrupt/unreadable store must not take the whole page down — the
    // library and import keep working; the binding editor shows the error.
    characters = [];
    charactersError = "The character store couldn't be read.";
    historyAssets = [];
  }

  if (charactersError) {
    return (
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-16 sm:px-6">
        <div role="alert" data-testid="voices.error">
          <EmptyState
            icon="alert"
            title="The voice library couldn't load its references"
            body="Nothing was lost — your recordings and bindings live in this browser. Refresh the page to retry reading the studio stores."
            action={
              <a
                href="/voices"
                className="inline-flex h-11 items-center gap-2 rounded-[7px] bg-primary-strong px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-dark"
              >
                <Icon name="refresh" size={16} aria-hidden="true" />
                Refresh
              </a>
            }
            testId="voices.error.state"
          />
        </div>
      </div>
    );
  }

  return (
    <VoiceLibrary
      characters={characters}
      historyAssets={historyAssets}
      charactersError={charactersError}
    />
  );
}
