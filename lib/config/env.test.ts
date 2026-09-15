import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStudioEnv, invalidateStudioEnv, resetStudioEnvForTests } from "@/lib/config/env";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testDir = "";

function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetStudioEnvForTests();
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "env-test-"));
  setProviderConfigPathForTests(join(testDir, "settings.json"));
  resetProviderConfigForTests();
  resetStudioEnvForTests();
});

afterEach(() => {
  setEnv({
    APIKEY_FAN_BASE_URL: undefined,
    APIKEY_FAN_API_KEY: undefined,
    SOGNI_API_KEY: undefined,
    LOG_LEVEL: undefined,
    MEDIA_CACHE_DIR: undefined,
  });
  setProviderConfigPathForTests(null);
  resetProviderConfigForTests();
  resetStudioEnvForTests();
  if (testDir) {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});

describe("env config", () => {
  it("defaults everything when no env is set", () => {
    setEnv({ APIKEY_FAN_API_KEY: undefined, SOGNI_API_KEY: undefined });
    const env = getStudioEnv();
    expect(env.apiKeyFanBaseUrl).toBe("https://apikey.fan/v1");
    expect(env.apiKeyFanApiKey).toBeNull();
    expect(env.sogniApiKey).toBeNull();
    expect(env.logLevel).toBe("info");
    expect(env.mediaCacheDir).toBe(".media-cache");
  });

  it("reads and trims the api key", () => {
    setEnv({ APIKEY_FAN_API_KEY: "  sk-test-123  " });
    expect(getStudioEnv().apiKeyFanApiKey).toBe("sk-test-123");
  });

  it("treats an empty key as unconfigured", () => {
    setEnv({ APIKEY_FAN_API_KEY: "" });
    expect(getStudioEnv().apiKeyFanApiKey).toBeNull();
  });

  it("prefers settings key over env key", () => {
    setEnv({ APIKEY_FAN_API_KEY: "sk-env-key" });
    updateProviderConfig({
      providers: { "apikey-fan": { apiKey: "sk-settings-key" } },
    });
    invalidateStudioEnv();
    expect(getStudioEnv().apiKeyFanApiKey).toBe("sk-settings-key");
  });

  it("falls back to env key when settings key is null", () => {
    setEnv({ APIKEY_FAN_API_KEY: "sk-env-key" });
    updateProviderConfig({
      providers: { "apikey-fan": { apiKey: null } },
    });
    invalidateStudioEnv();
    expect(getStudioEnv().apiKeyFanApiKey).toBe("sk-env-key");
  });

  it("applies settings key for sogni as well", () => {
    setEnv({ SOGNI_API_KEY: "sogni-env" });
    updateProviderConfig({
      providers: { sogni: { apiKey: "sogni-settings" } },
    });
    invalidateStudioEnv();
    expect(getStudioEnv().sogniApiKey).toBe("sogni-settings");
  });

  it("normalises a trailing slash on the base url", () => {
    setEnv({ APIKEY_FAN_BASE_URL: "https://apikey.fan/v1/" });
    expect(getStudioEnv().apiKeyFanBaseUrl).toBe("https://apikey.fan/v1");
  });

  it("appends /v1 when only a bare host is given", () => {
    setEnv({ APIKEY_FAN_BASE_URL: "https://relay.example.com" });
    expect(getStudioEnv().apiKeyFanBaseUrl).toBe("https://relay.example.com/v1");
  });

  it("lowercases the log level", () => {
    setEnv({ LOG_LEVEL: "DEBUG" });
    expect(getStudioEnv().logLevel).toBe("debug");
  });
});
