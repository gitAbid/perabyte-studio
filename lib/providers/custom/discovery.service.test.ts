import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/lib/providers/types";
import {
  resetProviderConfigForTests,
  setProviderConfigPathForTests,
  updateProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import { discoverProviderModels } from "./discovery.service";
import type { ProviderFormat } from "./formats/types";

const savedEntry = {
  id: "my-relay",
  label: "My Relay",
  format: "openai" as const,
  baseUrl: "https://relay.example/v1",
  apiKey: "sk-stored",
  enabled: true,
  models: [
    { model: "gpt-image-1", label: "Kept label", kind: "image" as const, enabled: true },
    { model: "vanished-model", kind: "text" as const, enabled: false },
  ],
};

function fakeFormat(
  listModels: ProviderFormat["listModels"],
  id: ProviderFormat["id"] = "openai",
): ProviderFormat {
  return {
    id,
    label: id,
    capabilities: { image: true, video: true, text: true },
    listModels: vi.fn(listModels),
  };
}

beforeEach(() => {
  setProviderConfigPathForTests(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), "discover-test-")), "settings.json"),
  );
});

afterEach(() => {
  setProviderConfigPathForTests(null);
  resetProviderConfigForTests();
});

describe("discoverProviderModels", () => {
  it("discovers and guesses for an unsaved provider", async () => {
    const format = fakeFormat(async () => [
      { model: "gpt-image-1", kind: "image" },
      { model: "grok-4.5", kind: "text" },
    ]);
    const result = await discoverProviderModels(
      { format: "openai", baseUrl: "https://x.example/v1", apiKey: "sk-new" },
      { openai: format },
    );
    expect(result.models).toEqual([
      { model: "gpt-image-1", kind: "image", enabled: true },
      { model: "grok-4.5", kind: "text", enabled: false },
    ]);
    expect(result.lastDiscoveredAt).toBeTruthy();
    // the format saw the explicit key, not a stored one
    expect(format.listModels).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-new", baseUrl: "https://x.example/v1" }),
    );
  });

  it("re-discovers a saved provider with its stored key and merges", async () => {
    updateProviderConfig({ customProviders: { upsert: savedEntry } });
    const format = fakeFormat(async () => [
      { model: "gpt-image-1", kind: "image" },
      { model: "sora-2", kind: "video" },
    ]);
    const result = await discoverProviderModels({ id: "my-relay" }, { openai: format });

    expect(format.listModels).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-stored" }),
    );
    // kept classification wins; vanished dropped; new appended guessed
    expect(result.models).toEqual([
      { model: "gpt-image-1", label: "Kept label", kind: "image", enabled: true },
      { model: "sora-2", kind: "video", enabled: true },
    ]);
  });

  it("an explicit key overrides the stored one on re-discovery", async () => {
    updateProviderConfig({ customProviders: { upsert: savedEntry } });
    const format = fakeFormat(async () => []);
    await discoverProviderModels({ id: "my-relay", apiKey: "sk-fresh" }, { openai: format });
    expect(format.listModels).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "sk-fresh" }),
    );
  });

  it("maps auth failures to the apiKey field", async () => {
    const format = fakeFormat(async () => {
      throw new ProviderError("The key was rejected.", { retryable: false, status: 401 });
    });
    await expect(
      discoverProviderModels({ format: "openai", baseUrl: "https://x.example" }, { openai: format }),
    ).rejects.toMatchObject({ field: "apiKey" });
  });

  it("maps endpoint failures to the baseUrl field", async () => {
    const format = fakeFormat(async () => {
      throw new ProviderError("Not found.", { retryable: false, status: 404 });
    });
    await expect(
      discoverProviderModels({ format: "openai", baseUrl: "https://x.example" }, { openai: format }),
    ).rejects.toMatchObject({ field: "baseUrl" });
  });

  it("rejects unknown formats and bad URLs before any network call", async () => {
    await expect(
      discoverProviderModels({ format: "soap", baseUrl: "https://x.example" }),
    ).rejects.toMatchObject({ field: "format" });
    await expect(
      discoverProviderModels({ format: "openai", baseUrl: "not-a-url" }),
    ).rejects.toMatchObject({ field: "baseUrl" });
  });

  it("rejects discovery for an unknown saved id", async () => {
    await expect(discoverProviderModels({ id: "ghost" })).rejects.toMatchObject({
      field: "id",
    });
  });
});
