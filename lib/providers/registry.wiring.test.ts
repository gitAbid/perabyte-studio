import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStudioEnvForTests } from "@/lib/config/env";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
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
