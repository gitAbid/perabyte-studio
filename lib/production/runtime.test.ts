import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openProductionStore } from "../repositories/production/sqlite";
import { resolveProductionDataDir, withProductionStore } from "./runtime";
import type { SqliteProductionStore } from "../repositories/production/sqlite";

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "production-runtime-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("production runtime", () => {
  it("resolves configured and default data directories without opening a store", () => {
    expect(resolveProductionDataDir({ PERABYTE_STUDIO_DATA_DIR: "/tmp/studio-data" }, "/app")).toBe("/tmp/studio-data");
    expect(resolveProductionDataDir({}, "/app")).toBe("/app/.studio");
  });

  it("opens lazily, awaits async work, closes on success and failure", async () => {
    const factory = vi.fn(() => {
      let closed = false;
      return { close: () => { closed = true; }, get closed() { return closed; } } as unknown as SqliteProductionStore;
    });
    expect(factory).not.toHaveBeenCalled();
    const success = await withProductionStore(async store => {
      await Promise.resolve();
      expect((store as SqliteProductionStore & { closed: boolean }).closed).toBe(false);
      return "ok";
    }, { storeFactory: factory });
    expect(success).toBe("ok");
    expect((factory.mock.results[0]!.value as SqliteProductionStore & { closed: boolean }).closed).toBe(true);
    await expect(withProductionStore(async () => { throw new Error("operation failed"); }, { storeFactory: factory })).rejects.toThrow("operation failed");
    expect((factory.mock.results[1]!.value as SqliteProductionStore & { closed: boolean }).closed).toBe(true);
  });

  it("reopens the configured SQLite store with committed data", async () => {
    const dataDir = tempDir();
    await withProductionStore(store => {
      store.transaction(tx => tx.insertProject({ version: 1, id: "runtime-project", name: "Saved", profileId: "storybook-short-v1", profile: { id: "storybook-short-v1", format: "9:16", language: "en", ageIntent: "5-8", targetFrames: 1152, projectCapMinor: null, dailyCapMinor: null }, activeCanonRevisionIds: [], activeStoryRevisionId: null, activeShotPlanRevisionId: null, activeAnimaticRevisionId: null, activeAudioMixRevisionId: null, takeSelectionVersion: 0, audioMixVersion: 0, createdAt: 1, updatedAt: 1, saveVersion: 1 }));
    }, { env: { PERABYTE_STUDIO_DATA_DIR: dataDir } });
    const reopened = openProductionStore({ dataDir });
    expect(reopened.read.getProject("runtime-project")?.name).toBe("Saved");
    reopened.close();
  });
});
