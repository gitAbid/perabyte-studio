"use client";

import { SelectField } from "@/components/ui";
import { useModelCatalog } from "@/lib/model-catalog";
import {
  setSelectedModel,
  useSettings,
} from "@/lib/repositories/settings.repository";
import type {
  ProviderSettingsUpdate,
  ProviderView,
} from "@/lib/services/provider-settings.service";

type OnUpdate = (patch: ProviderSettingsUpdate) => Promise<void>;

export function TaskModelsSection({
  providers,
  enhanceModel,
  onUpdate,
}: {
  providers: ProviderView[];
  enhanceModel: string | null;
  onUpdate: OnUpdate;
}) {
  const { settings, ready } = useSettings();
  const image = useModelCatalog("image");
  const video = useModelCatalog("video");
  const enhanceOptions = providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) =>
      provider.textModels
        .filter((model) => model.enabled)
        .map((model) => ({
          id: model.id,
          label: `${provider.label} — ${model.label}`,
        })),
    );

  return (
    <section>
      <p className="text-[11px] font-bold uppercase tracking-wide text-muted">
        Task models
      </p>
      <div className="mt-3 space-y-4 rounded-[14px] border border-border bg-surface p-4">
        {ready ? (
          <>
            <SelectField
              label="Default image model"
              value={settings.imageModel ?? ""}
              onChange={(event) =>
                setSelectedModel("image", event.target.value || null)
              }
            >
              <option value="">Workspace default</option>
              {image.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </SelectField>

            <SelectField
              label="Default video model"
              value={settings.videoModel ?? ""}
              onChange={(event) =>
                setSelectedModel("video", event.target.value || null)
              }
            >
              <option value="">Workspace default</option>
              {video.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </SelectField>

            <SelectField
              label="Prompt enhancement"
              value={enhanceModel ?? ""}
              onChange={(event) =>
                onUpdate({ tasks: { enhance: event.target.value || null } }).catch(
                  () => undefined,
                )
              }
            >
              <option value="">Auto (recommended)</option>
              {enhanceOptions.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </SelectField>

            <p className="border-t border-border pt-3 text-[11.5px] leading-snug text-muted">
              Per-workspace choices made with the Model badge in each prompt
              window override these defaults.
            </p>
          </>
        ) : (
          <p className="text-[12.5px] text-muted">Loading models…</p>
        )}
      </div>
    </section>
  );
}