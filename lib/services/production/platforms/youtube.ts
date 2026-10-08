import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { PlatformUploadRecordSchema, type PlatformUploadRecord } from "../../../production/contracts";

/**
 * YouTube publish adapter (M6-1, spec 15 Agent D). CONFIG-GATED: the whole
 * surface exists but surfaces ONLY when `YOUTUBE_CLIENT_ID` +
 * `YOUTUBE_CLIENT_SECRET` are configured on the machine — a disconnected
 * platform shows "Connect", never a fake-enabled Publish (spec rule). Every
 * upload attempt is an auditable `PlatformUploadRecord`; an OAuth or upload
 * failure NEVER marks a publication complete, and the export package stays
 * available regardless (spec acceptance 5).
 *
 * Tokens live in memory per process (refresh token persisted in the uploads
 * file, 0600) — this is a local single-user studio, not a multi-tenant SaaS;
 * the hosted-boundary doc (M6-4) covers what changes there.
 */

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
}

export function resolveYouTubeConfig(env: Readonly<Record<string, string | undefined>> = process.env): YouTubeConfig | null {
  const clientId = env.YOUTUBE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.YOUTUBE_CLIENT_SECRET?.trim() ?? "";
  if (clientId.length === 0 || clientSecret.length === 0) return null;
  return { clientId, clientSecret };
}

export const YOUTUBE_OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export function buildAuthorizeUrl(config: YouTubeConfig, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface YouTubeTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

export interface YouTubeTransport {
  exchangeCode(config: YouTubeConfig, code: string, redirectUri: string): Promise<YouTubeTokens>;
  refresh(config: YouTubeConfig, refreshToken: string): Promise<YouTubeTokens>;
  /** Initiates a resumable upload; returns the session URL. */
  initiateUpload(config: YouTubeConfig, accessToken: string, init: { title: string; description: string; privacyStatus: "public" | "unlisted" | "private"; videoBytes: number }): Promise<string>;
  /** Uploads the bytes to the session URL; returns the remote video id. */
  uploadBytes(sessionUrl: string, video: Uint8Array): Promise<{ remoteVideoId: string }>;
}

/** Default transport over fetch; injected transport is for tests. */
export const fetchYouTubeTransport: YouTubeTransport = {
  async exchangeCode(config, code, redirectUri) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!response.ok) throw new Error(`OAuth token exchange failed (${response.status}).`);
    const payload = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (typeof payload.access_token !== "string") throw new Error("OAuth response carried no access token.");
    return {
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
      expiresAt: Date.now() + (typeof payload.expires_in === "number" ? payload.expires_in * 1000 : 3600_000),
    };
  },
  async refresh(config, refreshToken) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }),
    });
    if (!response.ok) throw new Error(`OAuth refresh failed (${response.status}).`);
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof payload.access_token !== "string") throw new Error("OAuth refresh carried no access token.");
    return { accessToken: payload.access_token, refreshToken, expiresAt: Date.now() + (typeof payload.expires_in === "number" ? payload.expires_in * 1000 : 3600_000) };
  },
  async initiateUpload(config, accessToken, init) {
    const response = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(init.videoBytes),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: { title: init.title.slice(0, 100), description: init.description.slice(0, 5000) },
        status: { privacyStatus: init.privacyStatus, selfDeclaredMadeForKids: false },
      }),
    });
    if (!response.ok) throw new Error(`Upload initiation failed (${response.status}).`);
    const sessionUrl = response.headers.get("location");
    if (!sessionUrl) throw new Error("Upload initiation returned no session URL.");
    return sessionUrl;
  },
  async uploadBytes(sessionUrl, video) {
    const response = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": String(video.byteLength) },
      body: Buffer.from(video),
    });
    if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
    const payload = (await response.json().catch(() => ({}))) as { id?: string };
    if (typeof payload.id !== "string") throw new Error("Upload completed but YouTube returned no video id.");
    return { remoteVideoId: payload.id };
  },
};

/* ── Auditable upload records (C20) ────────────────────────────────────────── */

export const StoredUploadsSchema = z.object({ version: z.literal(1), records: z.array(PlatformUploadRecordSchema).max(10_000), refreshToken: z.string().nullable() });
export type StoredUploads = z.infer<typeof StoredUploadsSchema>;

export function resolveUploadsPath(dataDir: string): string {
  return resolve(join(dataDir, "platform-uploads.json"));
}

export async function loadUploads(dataDir: string): Promise<StoredUploads> {
  try {
    return StoredUploadsSchema.parse(JSON.parse(await readFile(resolveUploadsPath(dataDir), "utf8")));
  } catch {
    return { version: 1, records: [], refreshToken: null };
  }
}

export async function saveUploads(dataDir: string, stored: StoredUploads): Promise<void> {
  const path = resolveUploadsPath(dataDir);
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

export function newUploadRecord(input: { projectId: string; exportId: string; privacy: PlatformUploadRecord["privacy"]; now: number }): PlatformUploadRecord {
  return PlatformUploadRecordSchema.parse({
    version: 1,
    id: `upload-${Math.random().toString(36).slice(2, 12)}`,
    projectId: input.projectId,
    platform: "youtube",
    exportId: input.exportId,
    state: "queued",
    privacy: input.privacy,
    remoteVideoId: null,
    remoteUrl: null,
    error: null,
    createdAt: input.now,
    completedAt: null,
  });
}
