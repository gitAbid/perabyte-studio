import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl, loadUploads, newUploadRecord, resolveUploadsPath, resolveYouTubeConfig,
  saveUploads, type YouTubeTransport,
} from "./youtube";

const CONFIG = { clientId: "client-1", clientSecret: "secret-1" };

describe("youtube adapter (M6-1, config-gated)", () => {
  it("is configured ONLY when both credentials exist", () => {
    expect(resolveYouTubeConfig({ YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b" })).toEqual({ clientId: "a", clientSecret: "b" });
    expect(resolveYouTubeConfig({ YOUTUBE_CLIENT_ID: "a" })).toBeNull();
    expect(resolveYouTubeConfig({})).toBeNull();
  });

  it("builds an offline-scope authorize url with the callback and state", () => {
    const url = new URL(buildAuthorizeUrl(CONFIG, "http://localhost:3310/api/production/platforms/youtube/callback", "state-1"));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toContain("youtube.upload");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3310/api/production/platforms/youtube/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("keeps auditable records: upload attempts persist, failures carry the error and never complete", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "yt-uploads-"));
    const record = newUploadRecord({ projectId: "proj-1", exportId: "export-1", privacy: "unlisted", now: 1000 });
    expect(record).toMatchObject({ platform: "youtube", state: "queued", remoteVideoId: null, completedAt: null });

    const running = { ...record, state: "running" as const };
    const failed = { ...running, state: "failed" as const, error: "OAuth refresh failed (401)." };
    await saveUploads(dataDir, { version: 1, records: [failed], refreshToken: "refresh-1" });
    const loaded = await loadUploads(dataDir);
    expect(loaded.records[0]).toMatchObject({ id: record.id, state: "failed", error: "OAuth refresh failed (401)." });
    expect(loaded.records[0].completedAt).toBeNull();
    expect(loaded.refreshToken).toBe("refresh-1");
    expect(resolveUploadsPath(dataDir)).toContain("platform-uploads.json");
  });

  it("transport contract: initiate returns the session url, upload returns the remote id (fake round-trip)", async () => {
    const fake: YouTubeTransport = {
      async exchangeCode() { return { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000 }; },
      async refresh() { return { accessToken: "at2", refreshToken: "rt", expiresAt: Date.now() + 3600_000 }; },
      async initiateUpload() { return "https://session.example/upload"; },
      async uploadBytes(_url, video) {
        if (video.byteLength === 0) throw new Error("empty upload");
        return { remoteVideoId: "yt-video-1" };
      },
    };
    const session = await fake.initiateUpload(CONFIG, "at", { title: "t", description: "d", privacyStatus: "unlisted", videoBytes: 10 });
    expect(session).toBe("https://session.example/upload");
    expect((await fake.uploadBytes(session, new Uint8Array(10))).remoteVideoId).toBe("yt-video-1");
  });
});
