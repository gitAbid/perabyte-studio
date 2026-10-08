import { createHash } from "node:crypto";
import { canonicalJson, hashCanonicalJson } from "./hash";
import { describe, expect, it } from "vitest";

describe("canonical production hashes", () => {
  it("sorts nested object keys but preserves array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(hashCanonicalJson({ b: 2, a: 1 })).toBe(hashCanonicalJson({ a: 1, b: 2 }));
    expect(hashCanonicalJson(["pip", "moss"])).not.toBe(hashCanonicalJson(["moss", "pip"]));
  });

  it("normalizes strings and keys to NFC before hashing", () => {
    expect(canonicalJson({ "e\u0301": "Cafe\u0301" })).toBe('{"é":"Café"}');
    expect(hashCanonicalJson({ name: "e\u0301" })).toBe(hashCanonicalJson({ name: "é" }));
  });

  it("omits undefined object fields while rejecting undefined array entries", () => {
    expect(canonicalJson({ absent: undefined, present: null })).toBe('{"present":null}');
    expect(() => canonicalJson([undefined])).toThrow(/undefined.*array/i);
  });

  it("rejects values outside finite acyclic JSON", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/finite/i);
    expect(() => canonicalJson(Infinity)).toThrow(/finite/i);
    expect(() => canonicalJson(1n)).toThrow(/unsupported/i);
    expect(() => canonicalJson(new Date(0))).toThrow(/unsupported/i);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/i);
  });

  it("rejects NFC key collisions and does not hash unsupported values", () => {
    expect(() => canonicalJson({ "é": 1, "e\u0301": 2 })).toThrow(/collision/i);
    expect(hashCanonicalJson({ value: "test" })).toBe(
      createHash("sha256").update('{"value":"test"}', "utf8").digest("hex"),
    );
  });
});
