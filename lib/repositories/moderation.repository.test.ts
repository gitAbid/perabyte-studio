import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseVerdictReply } from "@/lib/domain/moderation";
import {
  clearModerationRepository,
  getModerationRepository,
  putModerationRepository,
  setModerationPathForTests,
} from "@/lib/repositories/moderation.repository";

const MODEL = "deepseek-v4-flash-vision-exp-dspark-1m";
const REF = "a".repeat(64) + ".png";

let tempFile: string;

beforeEach(() => {
  tempFile = path.join(
    os.tmpdir(),
    `moderation-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  setModerationPathForTests(tempFile);
});

afterEach(() => {
  setModerationPathForTests(null);
  if (tempFile) fs.rmSync(tempFile, { force: true });
});

describe("moderation repository", () => {
  it("round-trips a verdict and persists it to disk", () => {
    const verdict = parseVerdictReply(
      '{"sensitive":true,"category":"nudity","confidence":0.9,"reason":"x"}',
      MODEL,
    )!;
    putModerationRepository(REF, verdict);
    expect(getModerationRepository(REF)?.sensitive).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(tempFile, "utf-8"));
    expect(onDisk[REF].confidence).toBe(0.9);
  });

  it("drops malformed rows when loading a corrupt/edited file", () => {
    fs.writeFileSync(
      tempFile,
      JSON.stringify({ [REF]: { sensitive: "yes" }, garbage: 1 }),
    );
    expect(getModerationRepository(REF)).toBeUndefined();
  });

  it("survives an unreadable file and clears on demand", () => {
    fs.writeFileSync(tempFile, "{not json");
    expect(getModerationRepository(REF)).toBeUndefined();
    clearModerationRepository();
    putModerationRepository(
      REF,
      parseVerdictReply('{"sensitive":false,"category":null,"confidence":0.8,"reason":"x"}', MODEL)!,
    );
    expect(getModerationRepository(REF)?.sensitive).toBe(false);
  });
});
