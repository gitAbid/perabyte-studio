import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
  updateProviderConfig,
  type CustomProviderEntry,
} from "@/lib/repositories/provider-config.repository";
import { getGenerationRegistry } from "@/lib/providers/registry";

/**
 * The real app registry (not fakes): keyed providers first — apikey.fan,
 * Sogni — with the keyless Pollinations fallback last. A provider only shows
 * up once its credential is present.
 */
describe("app registry wiring", () => {
  let configDir: string;

  beforeEach(() => {
    // Hermetic gate: point the provider-config repository at a path with no
    // settings file so the dynamic gate uses the all-enabled default instead
    // of whatever the developer's real .studio/settings.json disables.
    configDir = mkdtempSync(path.join(tmpdir(), "perabyte-registry-"));
    setProviderConfigPathForTests(path.join(configDir, "settings.json"));
  });

  afterEach(() => {
    delete process.env.APIKEY_FAN_API_KEY;
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();
    setProviderConfigPathForTests(null);
    resetProviderConfigForTests();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("lists sogni models between apikey.fan and the keyless fallback", () => {
    process.env.APIKEY_FAN_API_KEY = "k";
    process.env.SOGNI_API_KEY = "k";
    resetStudioEnvForTests();
    const registry = getGenerationRegistry();

    const imageIds = registry.listModels("image").map((m) => m.id);
    expect(imageIds.indexOf("sogni:krea2_turbo_fp8_scaled")).toBeGreaterThan(
      imageIds.indexOf("apikey-fan:grok-imagine-image"),
    );
    expect(imageIds[imageIds.length - 1]).toBe("pollinations:flux");

    const videoIds = registry.listModels("video").map((m) => m.id);
    expect(videoIds).toContain("sogni:wan_v2.2-14b-fp8_t2v_lightx2v");
  });

  it("hides sogni models while SOGNI_API_KEY is unset", () => {
    process.env.APIKEY_FAN_API_KEY = "k";
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();
    const registry = getGenerationRegistry();

    expect(registry.listModels("image").map((m) => m.id)).not.toContain(
      "sogni:krea2_turbo_fp8_scaled",
    );
    expect(registry.findAnywhere("sogni:flux1-schnell-fp8")?.provider.id).toBe("sogni");
    expect(registry.resolve("sogni:flux1-schnell-fp8")).toBeNull();
  });
});

describe("custom providers in the registry", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(path.join(tmpdir(), "perabyte-registry-custom-"));
    setProviderConfigPathForTests(path.join(configDir, "settings.json"));
  });

  afterEach(() => {
    delete process.env.APIKEY_FAN_API_KEY;
    delete process.env.SOGNI_API_KEY;
    resetStudioEnvForTests();
    setProviderConfigPathForTests(null);
    resetProviderConfigForTests();
    rmSync(configDir, { recursive: true, force: true });
  });

  const custom: CustomProviderEntry = {
    id: "my-relay",
    label: "My Relay",
    format: "openai",
    baseUrl: "https://relay.example/v1",
    apiKey: "sk-x",
    enabled: true,
    models: [
      { model: "gpt-image-1", kind: "image", enabled: true },
      { model: "sora-2", kind: "video", enabled: true },
    ],
  };

  it("resolves custom models without a process restart", () => {
    process.env.APIKEY_FAN_API_KEY = "k";
    resetStudioEnvForTests();
    updateProviderConfig({ customProviders: { upsert: custom } });

    const registry = getGenerationRegistry();
    expect(registry.listModels("image").map((m) => m.id)).toContain("my-relay:gpt-image-1");
    expect(registry.listModels("video").map((m) => m.id)).toContain("my-relay:sora-2");

    const resolved = registry.resolve("my-relay:gpt-image-1");
    expect(resolved?.provider.id).toBe("my-relay");
    expect(resolved?.provider.label).toBe("My Relay");
  });

  it("sits keyed built-ins before custom providers before the keyless fallback", () => {
    process.env.APIKEY_FAN_API_KEY = "k";
    process.env.SOGNI_API_KEY = "k";
    resetStudioEnvForTests();
    updateProviderConfig({ customProviders: { upsert: custom } });

    const ids = getGenerationRegistry().listModels("image").map((m) => m.id);
    const customIndex = ids.indexOf("my-relay:gpt-image-1");
    expect(customIndex).toBeGreaterThan(ids.indexOf("apikey-fan:grok-imagine-image"));
    expect(ids[ids.length - 1]).toBe("pollinations:flux");
  });

  it("drops a disabled custom provider on the next config revision", () => {
    process.env.APIKEY_FAN_API_KEY = "k";
    resetStudioEnvForTests();
    updateProviderConfig({ customProviders: { upsert: custom } });
    expect(getGenerationRegistry().resolve("my-relay:gpt-image-1")).not.toBeNull();

    updateProviderConfig({ customProviders: { setModel: { providerId: "my-relay", model: "gpt-image-1", enabled: false } } });
    expect(getGenerationRegistry().resolve("my-relay:gpt-image-1")).toBeNull();
    expect(getGenerationRegistry().findAnywhere("my-relay:gpt-image-1")).toBeNull();

    updateProviderConfig({ customProviders: { remove: "my-relay" } });
    expect(getGenerationRegistry().findAnywhere("my-relay:sora-2")).toBeNull();
  });
});
