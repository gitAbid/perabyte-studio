import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getProviderConfig,
  updateProviderConfig,
  invalidateProviderConfigCache,
  setProviderConfigPathForTests,
  getDefaultProviderConfig,
} from "./provider-config.repository";

describe("provider-config.repository", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-config-test-"));
    configPath = path.join(tempDir, "settings.json");
    setProviderConfigPathForTests(configPath);
    invalidateProviderConfigCache();
  });

  afterEach(async () => {
    setProviderConfigPathForTests(null);
    invalidateProviderConfigCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns default config when file does not exist", () => {
    const config = getProviderConfig();
    expect(config).toEqual(getDefaultProviderConfig());
    expect(config.providers["apikey-fan"].enabled).toBe(true);
    expect(config.providers.sogni.enabled).toBe(true);
    expect(config.providers.pollinations.enabled).toBe(true);
    expect(config.providers["apikey-fan"].apiKey).toBeNull();
    expect(config.providers.sogni.apiKey).toBeNull();
    expect(config.providers.pollinations.apiKey).toBeNull();
    expect(config.tasks.enhance).toBeNull();
  });

  it("caches the read across calls until invalidated", async () => {
    const first = getProviderConfig();
    // mutate the file on disk behind its back
    await fs.writeFile(
      configPath,
      JSON.stringify({
        providers: {
          sogni: { enabled: false, apiKey: null, disabledModels: [] },
        },
      }),
      "utf-8"
    );
    const cached = getProviderConfig();
    expect(cached).toBe(first);

    invalidateProviderConfigCache();
    const reloaded = getProviderConfig();
    expect(reloaded).not.toBe(first);
    expect(reloaded.providers.sogni.enabled).toBe(false);
  });

  it("persists updates and invalidates cache", () => {
    const updated = updateProviderConfig({
      providers: {
        sogni: { enabled: false },
      },
      tasks: {
        enhance: "qwen3.6-35b-a3b-gguf-iq4xs",
      },
    });

    expect(updated.providers.sogni.enabled).toBe(false);
    expect(updated.providers["apikey-fan"].enabled).toBe(true);
    expect(updated.tasks.enhance).toBe("qwen3.6-35b-a3b-gguf-iq4xs");

    // next read sees the persisted state without manual invalidate
    const read = getProviderConfig();
    expect(read.providers.sogni.enabled).toBe(false);
    expect(read.tasks.enhance).toBe("qwen3.6-35b-a3b-gguf-iq4xs");
  });

  it("disables specific models without affecting provider enabled state", () => {
    updateProviderConfig({
      providers: {
        sogni: { disabledModels: ["flux1-dev-fp8"] },
      },
    });

    const read = getProviderConfig();
    expect(read.providers.sogni.disabledModels).toEqual(["flux1-dev-fp8"]);
    expect(read.providers.sogni.enabled).toBe(true);
  });

  it("stores and clears api keys", () => {
    updateProviderConfig({
      providers: {
        "apikey-fan": { apiKey: "custom_key_123" },
      },
    });

    let read = getProviderConfig();
    expect(read.providers["apikey-fan"].apiKey).toBe("custom_key_123");

    updateProviderConfig({
      providers: {
        "apikey-fan": { apiKey: null },
      },
    });

    read = getProviderConfig();
    expect(read.providers["apikey-fan"].apiKey).toBeNull();
  });

  it("drops malformed json gracefully to defaults", async () => {
    await fs.writeFile(configPath, "{ not valid json", "utf-8");
    const config = getProviderConfig();
    expect(config.providers.sogni.enabled).toBe(true);
  });

  it("preserves unmodified providers on partial patch", () => {
    updateProviderConfig({
      providers: {
        sogni: { enabled: false },
      },
    });

    updateProviderConfig({
      providers: {
        "apikey-fan": { apiKey: "fan_key" },
      },
    });

    const read = getProviderConfig();
    expect(read.providers.sogni.enabled).toBe(false);
    expect(read.providers["apikey-fan"].apiKey).toBe("fan_key");
    expect(read.providers.pollinations.enabled).toBe(true);
  });

  it("defaults render timeouts to 5 min images and 10 min videos", () => {
    const config = getProviderConfig();
    expect(config.renderTimeouts).toEqual({ image: 300, video: 600, staleness: 300 });
  });

  it("persists render timeout patches alongside existing settings", () => {
    updateProviderConfig({ providers: { sogni: { enabled: false } } });

    updateProviderConfig({ renderTimeouts: { video: 900 } });

    const read = getProviderConfig();
    expect(read.renderTimeouts).toEqual({ image: 300, video: 900, staleness: 300 });
    expect(read.providers.sogni.enabled).toBe(false);
  });

  it("sanitizes and clamps render timeouts loaded from disk", async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({ renderTimeouts: { image: 7, video: "lots", extra: 1 } }),
      "utf-8",
    );

    const config = getProviderConfig();
    // Below the 30 s floor clamps up; a non-number keeps the default.
    expect(config.renderTimeouts.image).toBe(30);
    expect(config.renderTimeouts.video).toBe(600);
  });
});

describe("render staleness knob", () => {
  it("applies a staleness patch and clamps out-of-band values", () => {
    updateProviderConfig({ renderTimeouts: { staleness: 120 } });
    expect(getProviderConfig().renderTimeouts.staleness).toBe(120);
    updateProviderConfig({ renderTimeouts: { staleness: 5 } });
    expect(getProviderConfig().renderTimeouts.staleness).toBe(60); // min clamp
    updateProviderConfig({ renderTimeouts: { staleness: 99_999 } });
    expect(getProviderConfig().renderTimeouts.staleness).toBe(1800); // max clamp
  });
});
