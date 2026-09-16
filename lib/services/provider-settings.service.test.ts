import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import { buildModelId, type ModelDescriptor } from "@/lib/domain/models";
import { setProvidersForTests } from "@/lib/providers/registry";
import type { ImageProvider, VideoProvider } from "@/lib/providers/types";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
} from "@/lib/repositories/provider-config.repository";
import {
  applyProviderSettingsUpdate,
  getProviderSettings,
  ProviderSettingsError,
} from "@/lib/services/provider-settings.service";

function fakeProvider(options: {
  id: string;
  label?: string;
  configured?: boolean;
  models?: ModelDescriptor[];
  textModelIds?: string[];
}): ImageProvider & VideoProvider {
  const models = options.models ?? [];
  const provider = {
    id: options.id,
    label: options.label ?? options.id,
    isConfigured: () => options.configured ?? true,
    listImageModels: () => models.filter((m) => m.kind === "image"),
    generateImage: async () => {
      throw new Error("not implemented");
    },
    listVideoModels: () => models.filter((m) => m.kind === "video"),
    generateVideo: async () => {
      throw new Error("not implemented");
    },
  } as ImageProvider & VideoProvider;
  if (options.textModelIds) {
    (provider as unknown as Record<string, unknown>).listTextModels = () =>
      options.textModelIds!.map((id) => ({ id, label: id.split(":")[1] }));
    (provider as unknown as Record<string, unknown>).generateText = async () => {
      throw new Error("not implemented");
    };
  }
  return provider;
}

const grokModel: ModelDescriptor = {
  id: buildModelId("apikey-fan", "grok-imagine-image-2.0"),
  providerId: "apikey-fan",
  kind: "image",
  model: "grok-imagine-image-2.0",
  label: "Grok Imagine 2.0",
};

const polliImage: ModelDescriptor = {
  id: buildModelId("pollinations", "flux"),
  providerId: "pollinations",
  kind: "image",
  model: "flux",
  label: "Flux",
};

function wireRegistry() {
  setProvidersForTests([
    fakeProvider({ id: "apikey-fan", label: "apikey.fan", models: [grokModel] }),
    fakeProvider({
      id: "sogni",
      label: "Sogni AI",
      models: [],
      textModelIds: ["sogni:qwen-a", "sogni:qwen-b"],
    }),
    fakeProvider({
      id: "pollinations",
      label: "Pollinations",
      models: [polliImage],
      textModelIds: ["pollinations:default"],
    }),
  ]);
}

// Redirect config I/O to a per-test temp file so tests never share disk state.
let tempConfigFile: string | null = null;

beforeEach(() => {
  tempConfigFile = path.join(
    os.tmpdir(),
    `provider-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  setProviderConfigPathForTests(tempConfigFile);
});

afterEach(() => {
  setProvidersForTests(null);
  resetProviderConfigForTests();
  if (tempConfigFile) {
    fs.rmSync(tempConfigFile, { force: true });
    tempConfigFile = null;
  }
  setProviderConfigPathForTests(null);
  delete process.env.SOGNI_API_KEY;
  delete process.env.APIKEY_FAN_API_KEY;
  resetStudioEnvForTests();
});

describe("provider settings service", () => {
  it("builds the inventory in priority order with masked keys", () => {
    process.env.SOGNI_API_KEY = "sk-env-key-1234";
    resetStudioEnvForTests();
    wireRegistry();
    const payload = getProviderSettings();
    expect(payload.providers.map((p) => p.id)).toEqual([
      "apikey-fan",
      "sogni",
      "pollinations",
    ]);
    const sogni = payload.providers[1];
    expect(sogni.keySource).toBe("env");
    expect(sogni.keyMasked).toBe("••••1234");
    expect(sogni.keySupported).toBe(true);
    expect(payload.providers[2].keySupported).toBe(false); // Pollinations is keyless
    expect(payload.providers[0].keySource).toBeNull();
    expect(sogni.textModels.map((m) => m.id)).toEqual(["sogni:qwen-a", "sogni:qwen-b"]);
  });

  it("reports a Settings-saved key with its source and mask", () => {
    wireRegistry();
    applyProviderSettingsUpdate({ providers: { sogni: { apiKey: "sk-saved-9999" } } });
    const sogni = getProviderSettings().providers[1];
    expect(sogni.keySource).toBe("settings");
    expect(sogni.keyMasked).toBe("••••9999");
  });

  it("shows picker models with their enabled flags", () => {
    wireRegistry();
    const polli = getProviderSettings().providers[2];
    expect(polli.models.map((m) => m.id)).toEqual(["pollinations:flux"]);
    expect(polli.models[0].enabled).toBe(true);
  });

  it("applies toggles and disables models", () => {
    wireRegistry();
    const payload = applyProviderSettingsUpdate({
      providers: {
        "apikey-fan": { enabled: false },
        pollinations: { disabledModels: ["pollinations:flux"] },
      },
    });
    expect(payload.providers[0].enabled).toBe(false);
    expect(payload.providers[2].models[0].enabled).toBe(false);
    expect(payload.providers[2].textModels[0].enabled).toBe(true); // models only
  });

  it("rejects disabling the last enabled provider", () => {
    wireRegistry();
    applyProviderSettingsUpdate({
      providers: { "apikey-fan": { enabled: false }, sogni: { enabled: false } },
    });
    expect(() =>
      applyProviderSettingsUpdate({ providers: { pollinations: { enabled: false } } }),
    ).toThrow(ProviderSettingsError);
  });

  it("rejects unknown providers, models, and enhance targets", () => {
    wireRegistry();
    expect(() =>
      applyProviderSettingsUpdate({ providers: { nope: { enabled: false } } }),
    ).toThrow(ProviderSettingsError);
    expect(() =>
      applyProviderSettingsUpdate({
        providers: { sogni: { disabledModels: ["sogni:ghost"] } },
      }),
    ).toThrow(/Unknown model/);
    expect(() =>
      applyProviderSettingsUpdate({ tasks: { enhance: "sogni:ghost" } }),
    ).toThrow(/enhancement/i);
    expect(() =>
      applyProviderSettingsUpdate({
        providers: { sogni: { apiKey: 5 as unknown as string } },
      }),
    ).toThrow(ProviderSettingsError);
  });

  it("treats an empty-string key as clear", () => {
    wireRegistry();
    applyProviderSettingsUpdate({ providers: { sogni: { apiKey: "sk-temp-abcd" } } });
    expect(getProviderSettings().providers[1].keySource).toBe("settings");
    const payload = applyProviderSettingsUpdate({ providers: { sogni: { apiKey: "" } } });
    expect(payload.providers[1].keySource).not.toBe("settings");
  });

  it("accepts the enhance selection only from known text models", () => {
    wireRegistry();
    const payload = applyProviderSettingsUpdate({ tasks: { enhance: "sogni:qwen-b" } });
    expect(payload.tasks.enhance).toBe("sogni:qwen-b");
    applyProviderSettingsUpdate({ tasks: { enhance: null } });
    expect(getProviderSettings().tasks.enhance).toBeNull();
  });

  it("reports tasks.writer in the payload", () => {
    wireRegistry();
    const payload = getProviderSettings();
    expect(payload.tasks.writer).toBeNull();
  });

  it("accepts a known writer text model and rejects unknown ones", () => {
    wireRegistry();
    applyProviderSettingsUpdate({ tasks: { writer: "sogni:qwen-a" } });
    expect(getProviderSettings().tasks.writer).toBe("sogni:qwen-a");

    expect(() =>
      applyProviderSettingsUpdate({ tasks: { writer: "sogni:ghost" } }),
    ).toThrow(ProviderSettingsError);
    expect(getProviderSettings().tasks.writer).toBe("sogni:qwen-a"); // unchanged on rejection
  });

  it("accepts text models in a provider's disabled list", () => {
    wireRegistry();
    const payload = applyProviderSettingsUpdate({
      providers: { sogni: { disabledModels: ["sogni:qwen-a"] } },
    });
    expect(payload.providers[1].textModels[0].enabled).toBe(false);
  });

  it("exposes render timeouts and persists updates in seconds", () => {
    wireRegistry();
    // Defaults: 5 minutes images, 10 minutes videos.
    expect(getProviderSettings().renderTimeouts).toEqual({ image: 300, video: 600, staleness: 300 });

    const payload = applyProviderSettingsUpdate({
      renderTimeouts: { image: 480, video: 900, staleness: 300 },
    });
    expect(payload.renderTimeouts).toEqual({ image: 480, video: 900, staleness: 300 });
    expect(getProviderSettings().renderTimeouts).toEqual({ image: 480, video: 900, staleness: 300 });
  });

  it("clamps render timeouts into the safe range", () => {
    wireRegistry();
    const payload = applyProviderSettingsUpdate({ renderTimeouts: { image: 1, video: 100000 } });
    expect(payload.renderTimeouts.image).toBe(30); // 30 s floor
    expect(payload.renderTimeouts.video).toBe(3600); // 1 h ceiling
  });

  it("rejects non-numeric render timeouts", () => {
    wireRegistry();
    expect(() =>
      applyProviderSettingsUpdate({
        renderTimeouts: { video: "ten" as unknown as number },
      }),
    ).toThrow(/render timeout/i);
  });

  it("leaves render timeouts untouched on unrelated updates", () => {
    wireRegistry();
    applyProviderSettingsUpdate({ renderTimeouts: { video: 900 } });
    applyProviderSettingsUpdate({ tasks: { enhance: "sogni:qwen-b" } });
    expect(getProviderSettings().renderTimeouts).toEqual({ image: 300, video: 900, staleness: 300 });
  });
});
