import { afterEach, describe, expect, it } from "vitest";
import { isPlausibleMp4 } from "./mp4";

/** Smallest structurally complete MP4 skeleton: ftyp + moov + mdat. */
function mp4With(...boxTypes: string[]): Buffer {
  const header = Buffer.alloc(8, 0);
  header.writeUInt32BE(16, 0);
  header.write("ftyp", 4, "latin1");
  const boxes = boxTypes.map((type) => {
    const box = Buffer.alloc(16, 0);
    box.writeUInt32BE(16, 0);
    box.write(type, 4, "latin1");
    return box;
  });
  return Buffer.concat([header, ...boxes]);
}

describe("isPlausibleMp4", () => {
  it("accepts a file with an index and payload box", () => {
    expect(isPlausibleMp4(mp4With("moov", "mdat"))).toBe(true);
    expect(isPlausibleMp4(mp4With("mdat", "moof"))).toBe(true);
  });

  it("rejects a placeholder stub (ftyp + zero padding)", () => {
    const stub = Buffer.alloc(64, 0);
    stub.writeUInt32BE(24, 0);
    stub.write("ftyp", 4, "latin1");
    expect(isPlausibleMp4(stub)).toBe(false);
  });

  it("rejects non-mp4 payloads", () => {
    expect(isPlausibleMp4(Buffer.from("<html>error</html> padding padding"))).toBe(false);
    expect(isPlausibleMp4(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64)]))).toBe(false);
  });

  it("rejects empty and undersized buffers", () => {
    expect(isPlausibleMp4(Buffer.alloc(0))).toBe(false);
    expect(isPlausibleMp4(Buffer.alloc(16, 0))).toBe(false);
  });

  it("rejects ftyp-less buffers even when moov appears", () => {
    const buffer = Buffer.alloc(64, 0);
    buffer.write("moov", 20, "latin1");
    expect(isPlausibleMp4(buffer)).toBe(false);
  });
});
