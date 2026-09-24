import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  deleteLocationsRepository,
  getLocationsRepository,
  listLocationsRepository,
  patchLocationRepository,
  putLocationRepository,
  setLocationsPathForTests,
} from "./locations.repository";
import {
  listLocations,
  patchLocation,
  putLocation,
  removeLocations,
} from "@/lib/services/locations.service";
import type { LocationRow } from "./location-row";

function row(overrides: Partial<LocationRow> = {}): LocationRow {
  return {
    id: "loc_test",
    name: "The Docks",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("locations.repository + locations.service", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-locations-test-"));
    storePath = path.join(tempDir, "locations.json");
    setLocationsPathForTests(storePath);
  });

  afterEach(async () => {
    setLocationsPathForTests(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns an empty store when the file does not exist", () => {
    expect(listLocationsRepository()).toEqual([]);
  });

  it("returns an empty store for a corrupt file", async () => {
    await fs.writeFile(storePath, "{not json", "utf-8");
    expect(listLocationsRepository()).toEqual([]);
  });

  it("put upserts newest-first and round-trips through disk", () => {
    putLocationRepository(row({ id: "a", updatedAt: 1 }));
    putLocationRepository(row({ id: "b", updatedAt: 2 }));
    putLocationRepository(row({ id: "a", updatedAt: 3 })); // replace, moves to front

    const rows = listLocationsRepository();
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    // A fresh read hits the file again (new module cache via set-for-tests)
    setLocationsPathForTests(storePath);
    expect(listLocationsRepository().map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("get finds one row or undefined", () => {
    putLocationRepository(row({ id: "a" }));
    expect(getLocationsRepository("a")?.name).toBe("The Docks");
    expect(getLocationsRepository("missing")).toBeUndefined();
  });

  it("patch merges onto one row and reports null for unknown ids", () => {
    putLocationRepository(row({ id: "a", name: "The Docks" }));
    const patched = patchLocationRepository("a", { name: "The Old Docks" });
    expect(patched?.name).toBe("The Old Docks");
    expect(patchLocationRepository("missing", { name: "x" })).toBeNull();
    expect(getLocationsRepository("a")?.name).toBe("The Old Docks");
  });

  it("delete removes only the given ids and reports the count", () => {
    putLocationRepository(row({ id: "a" }));
    putLocationRepository(row({ id: "b" }));
    expect(deleteLocationsRepository(["a", "zz"])).toBe(1);
    expect(listLocationsRepository().map((r) => r.id)).toEqual(["b"]);
  });

  describe("service", () => {
    it("putLocation validates rows and rejects invalid payloads", () => {
      expect(putLocation(row({ id: "ok" }))).not.toBeNull();
      expect(putLocation({ id: "", name: "x", createdAt: 1, updatedAt: 1 })).toBeNull();
      expect(putLocation("garbage")).toBeNull();
    });

    it("listLocations sorts by updatedAt desc and clamps on load", () => {
      putLocation(row({ id: "old", updatedAt: 10 }));
      putLocation(row({ id: "new", updatedAt: 20 }));
      const rows = listLocations();
      expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    });

    it("patchLocation merges, bumps updatedAt, revalidates, and 404s unknown", () => {
      putLocation(row({ id: "a", name: "The Docks", updatedAt: 1 }));
      const before = Date.now();
      const patched = patchLocation("a", { name: "Renamed", favorite: true });
      expect(patched?.name).toBe("Renamed");
      expect(patched?.favorite).toBe(true);
      expect((patched?.updatedAt ?? 0) - before).toBeLessThan(50);

      expect(patchLocation("missing", { name: "x" })).toBeNull();
      // invalid patch payload is rejected, not merged
      expect(patchLocation("a", { ref: 12345 })).not.toBeNull(); // drops bad field, still merges
      expect(patchLocation("a", { createdAt: "bogus" })).toBeNull();
    });

    it("removeLocations deletes and counts", () => {
      putLocation(row({ id: "a" }));
      putLocation(row({ id: "b" }));
      expect(removeLocations(["a", "nope"])).toBe(1);
      expect(listLocations().map((r) => r.id)).toEqual(["b"]);
    });
  });
});
