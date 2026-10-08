import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDefaultProviderConfig,
  setProviderConfigPathForTests,
  type CustomProviderEntry,
  type ProviderConfig,
} from "@/lib/repositories/provider-config.repository";
import { listTextEngineOptions } from "@/lib/services/text-engine-chain";
import { SOGNI_TEXT_MODELS } from "@/lib/providers/sogni/sogni.text";
import { POLLINATIONS_TEXT_MODELS } from "@/lib/providers/pollinations/pollinations.text";
import * as textEnginesRoute from "@/app/api/production/text-engines/route";

/** Options the default (all-built-ins-enabled) config must produce, in chain order. */
const DEFAULT_OPTIONS = [
  ...SOGNI_TEXT_MODELS.map((model) => ({
    providerId: "sogni",
    modelId: model.id,
    label: `${model.id} — Sogni`,
  })),
  ...POLLINATIONS_TEXT_MODELS.map((model) => ({
    providerId: "pollinations",
    modelId: model.id,
    label: `${model.id} — Pollinations`,
  })),
];

/** A custom gateway fixture with one enabled text model, one disabled text model and one image model. */
function gatewayFixture(overrides: Partial<CustomProviderEntry> = {}): CustomProviderEntry {
  return {
    id: "my-gateway",
    label: "My Gateway",
    format: "openai",
    baseUrl: "https://gateway.example.internal/v1",
    apiKey: "sk-gateway-secret-value",
    enabled: true,
    models: [
      { model: "gw-text-main", label: "GW Text Main", kind: "text", enabled: true },
      { model: "gw-text-off", kind: "text", enabled: false },
      { model: "gw-image", kind: "image", enabled: true },
    ],
    ...overrides,
  };
}

function configWith(mutate: (config: ProviderConfig) => void): ProviderConfig {
  const config = getDefaultProviderConfig();
  mutate(config);
  return config;
}

/* Redirect config I/O to a per-test temp file so the route handler reads it. */
let tempConfigFile: string | null = null;

function useConfigFile(value: unknown): void {
  tempConfigFile = path.join(
    os.tmpdir(),
    `c21-text-engines-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(tempConfigFile, typeof value === "string" ? value : JSON.stringify(value), "utf-8");
  setProviderConfigPathForTests(tempConfigFile);
}

afterEach(() => {
  if (tempConfigFile) {
    fs.rmSync(tempConfigFile, { force: true });
    tempConfigFile = null;
  }
  setProviderConfigPathForTests(null);
});

describe("listTextEngineOptions (pure listing over an injected config)", () => {
  it("lists sogni then pollinations with chain-order ids and provider-labelled options", () => {
    expect(listTextEngineOptions(getDefaultProviderConfig())).toEqual(DEFAULT_OPTIONS);
  });

  it("drops every engine of a disabled provider but keeps the others", () => {
    const sogniOff = configWith((config) => { config.providers.sogni.enabled = false; });
    expect(listTextEngineOptions(sogniOff).map((option) => option.providerId)).toEqual(["pollinations"]);
    const pollinationsOff = configWith((config) => { config.providers.pollinations.enabled = false; });
    expect(listTextEngineOptions(pollinationsOff)).toEqual(DEFAULT_OPTIONS.filter((option) => option.providerId === "sogni"));
  });

  it("hides individual models listed in the provider's disabledModels", () => {
    const disabled = SOGNI_TEXT_MODELS[0]!.id;
    const config = configWith((config) => { config.providers.sogni.disabledModels = [disabled]; });
    const options = listTextEngineOptions(config);
    expect(options.map((option) => option.modelId)).not.toContain(disabled);
    expect(options).toEqual(DEFAULT_OPTIONS.filter((option) => option.modelId !== disabled));
  });

  it("includes each enabled custom gateway's enabled text models with the gateway's configured name", () => {
    const config = configWith((config) => { config.customProviders = [gatewayFixture()]; });
    const options = listTextEngineOptions(config);
    // Only the enabled text model survives; disabled text and image models never list.
    expect(options.slice(0, DEFAULT_OPTIONS.length)).toEqual(DEFAULT_OPTIONS);
    expect(options[DEFAULT_OPTIONS.length]).toEqual({
      providerId: "my-gateway",
      modelId: "my-gateway:gw-text-main",
      label: "my-gateway:gw-text-main — My Gateway",
    });
    expect(options).toHaveLength(DEFAULT_OPTIONS.length + 1);
  });

  it("excludes disabled custom gateways and falls back to the gateway id when no label is configured", () => {
    const disabledGateway = configWith((config) => {
      config.customProviders = [gatewayFixture({ enabled: false, label: "" })];
    });
    expect(listTextEngineOptions(disabledGateway)).toEqual(DEFAULT_OPTIONS);

    const unlabeled = configWith((config) => {
      config.customProviders = [gatewayFixture({ label: undefined as unknown as string })];
    });
    const options = listTextEngineOptions(unlabeled);
    expect(options.at(-1)).toEqual({
      providerId: "my-gateway",
      modelId: "my-gateway:gw-text-main",
      label: "my-gateway:gw-text-main — my-gateway",
    });
  });

  it("returns an empty array when no engine is validly configured", () => {
    const none = configWith((config) => {
      config.providers.sogni.enabled = false;
      config.providers.pollinations.enabled = false;
      config.customProviders = [];
    });
    expect(listTextEngineOptions(none)).toEqual([]);
  });

  it("never throws on config weirdness and keeps the default-on built-ins", () => {
    const weird = { version: 1, providers: {}, customProviders: [{ id: "broken" }] } as unknown as ProviderConfig;
    expect(() => listTextEngineOptions(weird)).not.toThrow();
    expect(listTextEngineOptions(weird)).toEqual(DEFAULT_OPTIONS);
    expect(listTextEngineOptions({ ...weird, customProviders: undefined } as unknown as ProviderConfig)).toEqual(DEFAULT_OPTIONS);
    expect(listTextEngineOptions(null as unknown as ProviderConfig)).toEqual(DEFAULT_OPTIONS);
  });

  it("drops credentials and endpoints structurally — options carry ids and labels only", () => {
    const secretConfig = configWith((config) => {
      config.providers.sogni.apiKey = "sk-sogni-secret-value";
      config.customProviders = [gatewayFixture()];
    });
    const options = listTextEngineOptions(secretConfig);
    const serialized = JSON.stringify(options);
    expect(serialized).not.toContain("sk-sogni-secret-value");
    expect(serialized).not.toContain("sk-gateway-secret-value");
    expect(serialized).not.toContain("gateway.example.internal");
    for (const option of options) {
      expect(Object.keys(option).sort()).toEqual(["label", "modelId", "providerId"]);
    }
  });
});

describe("GET /api/production/text-engines route handler", () => {
  it("serves the configured engines with cache-control no-store and no credentials", async () => {
    useConfigFile(configWith((config) => { config.customProviders = [gatewayFixture()]; }));
    const response = await textEnginesRoute.GET(new Request("http://localhost/api/production/text-engines"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { engines: Array<{ providerId: string; modelId: string; label: string }> };
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("sk-gateway-secret-value");
    expect(serialized).not.toContain("gateway.example.internal");
    expect(body.engines).toEqual([...DEFAULT_OPTIONS, {
      providerId: "my-gateway",
      modelId: "my-gateway:gw-text-main",
      label: "my-gateway:gw-text-main — My Gateway",
    }]);
  });

  it("answers an honest empty list when nothing is validly configured", async () => {
    useConfigFile(configWith((config) => {
      config.providers.sogni.enabled = false;
      config.providers.pollinations.enabled = false;
    }));
    const response = await textEnginesRoute.GET(new Request("http://localhost/api/production/text-engines"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ engines: [] });
  });

  it("degrades to the default engines on an unreadable config file instead of throwing", async () => {
    useConfigFile("{definitely not json");
    const response = await textEnginesRoute.GET(new Request("http://localhost/api/production/text-engines"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ engines: DEFAULT_OPTIONS });
  });

  it("is GET-only", () => {
    expect((textEnginesRoute as unknown as Record<string, unknown>).POST).toBeUndefined();
    expect(typeof textEnginesRoute.GET).toBe("function");
  });
});
