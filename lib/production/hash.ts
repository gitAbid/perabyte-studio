import { createHash } from "node:crypto";

/** Raised when an input cannot be represented as deterministic JSON. */
export class CanonicalizationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

function encode(value: unknown, ancestors: WeakSet<object>, inArray: boolean): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalizationError("Canonical JSON requires finite numbers");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (value === undefined) {
    if (inArray) throw new CanonicalizationError("Undefined array entries are not valid JSON");
    return undefined;
  }
  if (typeof value !== "object") {
    throw new CanonicalizationError(`Unsupported canonical JSON value: ${typeof value}`);
  }

  if (ancestors.has(value)) throw new CanonicalizationError("Canonical JSON cannot contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new CanonicalizationError("Unsupported array subclass");
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key === "symbol" || (key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)))) {
        throw new CanonicalizationError("Unsupported custom array property");
      }
      const parts: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new CanonicalizationError("Sparse arrays and accessor entries are not valid JSON");
        }
        const part = encode(descriptor.value, ancestors, true);
        if (part === undefined) throw new CanonicalizationError("Undefined array entries are not valid JSON");
        parts.push(part);
      }
      return `[${parts.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError("Unsupported non-plain object in canonical JSON");
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      throw new CanonicalizationError("Symbol-keyed properties are not valid JSON");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const normalized = new Map<string, unknown>();
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new CanonicalizationError("Non-enumerable and accessor properties are not valid JSON");
      }
      const normalizedKey = key.normalize("NFC");
      if (normalized.has(normalizedKey)) {
        throw new CanonicalizationError(`Canonicalization collision after NFC normalization: ${normalizedKey}`);
      }
      normalized.set(normalizedKey, descriptor.value);
    }

    const parts: string[] = [];
    for (const key of [...normalized.keys()].sort()) {
      const child = encode(normalized.get(key), ancestors, false);
      if (child !== undefined) parts.push(`${JSON.stringify(key)}:${child}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Canonical JSON: sorted NFC object keys, NFC strings, and ordered arrays. */
export function canonicalJson(value: unknown): string {
  const encoded = encode(value, new WeakSet<object>(), false);
  if (encoded === undefined) throw new CanonicalizationError("The canonical JSON root cannot be undefined");
  return encoded;
}

/** SHA-256 of a canonical production input. The digest is always lowercase. */
export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
