import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMediaVault } from "./vault";
import sharp from "sharp";

const dirs: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function createVault() { const dir = await mkdtemp(join(tmpdir(), "perabyte-vault-")); dirs.push(dir); return { dir, vault: new LocalMediaVault({ root: join(dir, "media"), maxBytes: 1024 * 1024 }) }; }

function onePixelPng() { return sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 30, g: 80, b: 120, alpha: 1 } } }).png().toBuffer(); }
function shortWav() {
  const samples = Buffer.alloc(480);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

describe("durable media vault", () => {
  it("atomically stores bytes by checksum and reopens verified content", async () => {
    const { vault } = await createVault();
    const png = await onePixelPng();
    const stored = await vault.put(png, { mime: "image/png", sourceKind: "upload" });
    expect(stored.asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.asset).toMatchObject({ width: 1, height: 1 });
    expect(await vault.read(stored.asset.vaultRef)).toEqual(png);
    expect(await vault.verify(stored.asset.vaultRef, stored.asset.sha256)).toBe(true);
  });
  it("keeps decoded media staged until explicit publish and removes staged bytes on abort", async () => {
    const { dir, vault } = await createVault();
    const staged = await vault.stageStream((await import("node:stream")).Readable.from([await onePixelPng()]), { mime: "image/png", sourceKind: "upload" });
    await expect(readFile(join(dir, "media", "sha256", staged.media.asset.sha256.slice(0, 2), staged.media.asset.sha256))).rejects.toMatchObject({ code: "ENOENT" });
    await staged.abort();
    const leftovers = await import("node:fs/promises").then(fs => fs.readdir(join(dir, "media")));
    expect(leftovers).toEqual([]);
  });
  it("rejects traversal, symlink escape, oversize, MIME mismatch and checksum mismatch", async () => {
    const { dir, vault } = await createVault();
    await expect(vault.read("../../etc/passwd")).rejects.toThrow();
    const outside = join(dir, "outside"); await writeFile(outside, "private"); await symlink(outside, join(dir, "media-link"));
    await expect(vault.read(join(dir, "media-link"))).rejects.toThrow();
    await expect(new LocalMediaVault({ root: join(dir, "limited"), maxBytes: 64 }).put(await onePixelPng(), { mime: "image/png", sourceKind: "upload" })).rejects.toThrow(/size|large/i);
    await expect(vault.put(Buffer.from("not a png"), { mime: "image/png", sourceKind: "upload" })).rejects.toThrow(/mime|content/i);
    const stored = await vault.put(await onePixelPng(), { mime: "image/png", sourceKind: "upload" });
    await expect(vault.readVerified(stored.asset.vaultRef, "0".repeat(64))).rejects.toThrow(/checksum/i);
  });
  it("decodes audio and stores probed sample metadata; rejects corrupt media with a valid-looking header", async () => {
    const { vault } = await createVault();
    const audio = await vault.put(shortWav(), { mime: "audio/wav", sourceKind: "upload" });
    expect(audio.asset).toMatchObject({ audioSamples: 240, width: null, height: null });
    await expect(vault.put(Buffer.from("\x89PNG\r\n\x1a\nnot a decodable image"), { mime: "image/png", sourceKind: "upload" })).rejects.toThrow(/decode|probe|invalid|media/i);
    await expect(vault.put(shortWav().subarray(0, 46), { mime: "audio/wav", sourceKind: "upload" })).rejects.toThrow(/decode|probe|invalid|media/i);
  });
  it("fully decodes video and records frame, rate and dimensions from the stream", async () => {
    const { dir, vault } = await createVault();
    const source = join(dir, "fixture.mp4");
    await execFileAsync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=24", "-frames:v", "24", "-an", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", source], { timeout: 30_000 });
    const stored = await vault.put(await readFile(source), { mime: "video/mp4", sourceKind: "upload" });
    expect(stored.asset).toMatchObject({ width: 16, height: 16, frames: 24, fps: 24, audioSamples: null });
  });
  it("refuses to use a symlink as the configured vault root", async () => {
    const { dir } = await createVault();
    const outside = join(dir, "outside-root"); await mkdir(outside);
    const rootLink = join(dir, "root-link"); await symlink(outside, rootLink);
    const vault = new LocalMediaVault({ root: rootLink, maxBytes: 64 });
    await expect(vault.put(Buffer.from("unsafe"), { mime: "text/plain", sourceKind: "upload" })).rejects.toThrow(/symlink|vault root/i);
  });
});
