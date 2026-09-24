import { describe, expect, it } from "vitest";
import { parseLocationRow } from "@/lib/repositories/location-row";

const base = {
  id: "loc_1",
  name: "The Docks",
  createdAt: 1,
  updatedAt: 1,
};

describe("parseLocationRow", () => {
  it("accepts a valid row and passes extras through", () => {
    const row = parseLocationRow({
      ...base,
      description: "Cranes over black water at dawn",
      ref: "a".repeat(64) + ".jpg",
      lighting: "overcast",
      palette: "teal and rust",
      favorite: true,
      futureField: 1,
    });
    expect(row).not.toBeNull();
    expect(row!.name).toBe("The Docks");
    expect(row!.description).toBe("Cranes over black water at dawn");
    expect(row!.ref).toBe("a".repeat(64) + ".jpg");
    expect(row!.lighting).toBe("overcast");
    expect(row!.palette).toBe("teal and rust");
    expect(row!.favorite).toBe(true);
    expect((row as unknown as Record<string, unknown>).futureField).toBe(1);
  });

  it("rejects rows missing identity or timestamps", () => {
    expect(parseLocationRow(null)).toBeNull();
    expect(parseLocationRow(undefined)).toBeNull();
    expect(parseLocationRow("nope")).toBeNull();
    expect(parseLocationRow({ ...base, id: "" })).toBeNull();
    expect(parseLocationRow({ ...base, name: 5 })).toBeNull();
    expect(parseLocationRow({ ...base, createdAt: "x" })).toBeNull();
    expect(parseLocationRow({ ...base, updatedAt: undefined })).toBeNull();
  });

  it("keeps a minimal row with only the required fields", () => {
    const row = parseLocationRow({ ...base });
    expect(row).not.toBeNull();
    expect(row!.description).toBeUndefined();
    expect(row!.ref).toBeUndefined();
    expect(row!.lighting).toBeUndefined();
    expect(row!.palette).toBeUndefined();
    expect(row!.favorite).toBeUndefined();
  });

  it("coerces optional fields defensively", () => {
    const bad = parseLocationRow({
      ...base,
      description: 9,
      ref: true,
      lighting: {},
      palette: [],
      favorite: "yes",
    });
    expect(bad!.description).toBeUndefined();
    expect(bad!.ref).toBeUndefined();
    expect(bad!.lighting).toBeUndefined();
    expect(bad!.palette).toBeUndefined();
    expect(bad!.favorite).toBeUndefined();

    const good = parseLocationRow({
      ...base,
      description: "",
      ref: "b".repeat(64) + ".png",
      favorite: false,
    });
    expect(good!.description).toBe("");
    expect(good!.ref).toBe("b".repeat(64) + ".png");
    expect(good!.favorite).toBe(false);
  });
});
