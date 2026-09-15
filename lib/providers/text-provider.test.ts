import { describe, it, expect, vi, beforeEach } from "vitest";
import { sogniProvider } from "@/lib/providers/sogni/sogni.provider";
import { pollinationsProvider } from "@/lib/providers/pollinations/pollinations.provider";
import { isTextProvider } from "@/lib/providers/types";
import { resetStudioEnvForTests } from "@/lib/config/env";
import { setProviderConfigPathForTests } from "@/lib/repositories/provider-config.repository";

describe("TextProvider implementations", () => {
  beforeEach(() => {
    resetStudioEnvForTests();
    setProviderConfigPathForTests(null);
    vi.restoreAllMocks();
  });

  describe("Sogni TextProvider", () => {
    it("satisfies the isTextProvider guard", () => {
      expect(isTextProvider(sogniProvider)).toBe(true);
    });

    it("lists valid text models with IDs, labels, and descriptions", () => {
      const models = sogniProvider.listTextModels();
      expect(models.length).toBe(3);
      expect(models[0].id).toBe("sogni:qwen3.5-35b-a3b-abliterated-gguf-q4km");
      expect(models[0].provider).toBe("sogni");
      expect(models[0].reasoning).toBe(true);
    });

    it("generates text via sogni chat completion", async () => {
      vi.stubEnv("SOGNI_API_KEY", "test-key");
      resetStudioEnvForTests();

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Enhanced cinematic prompt" } }],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await sogniProvider.generateText({
        userPrompt: "A cat in a garden",
      });

      expect(result.text).toBe("Enhanced cinematic prompt");
      expect(result.provider).toBe("sogni");
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  describe("Pollinations TextProvider", () => {
    it("satisfies the isTextProvider guard", () => {
      expect(isTextProvider(pollinationsProvider)).toBe(true);
    });

    it("lists default keyless model", () => {
      const models = pollinationsProvider.listTextModels();
      expect(models.length).toBe(1);
      expect(models[0].id).toBe("pollinations:default");
      expect(models[0].provider).toBe("pollinations");
    });

    it("generates text via GET request", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "A dramatic photo of a cat in a blooming garden",
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await pollinationsProvider.generateText({
        userPrompt: "A cat in a garden",
      });

      expect(result.text).toBe("A dramatic photo of a cat in a blooming garden");
      expect(result.provider).toBe("pollinations");
    });
  });
});
