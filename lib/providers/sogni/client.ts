import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStudioEnv } from "@/lib/config/env";
import type { SogniImageParams, SogniVideoParams } from "@/lib/providers/sogni/request-maps";

/**
 * Sogni Supernet client holder. The SDK opens a WebSocket, and Sogni allows
 * **one live connection per appId** — a second replaces the first. The client
 * is therefore created once per process and reused. The SDK is imported
 * lazily so cold starts and unit tests never pay for it (tests inject fakes
 * through `setSogniClientForTests`).
 */

/** The slice of the SDK surface the provider actually consumes (ISP). */
export interface SogniProject {
  waitForCompletion(): Promise<string[]>;
}

export interface SogniClient {
  projects: {
    create(params: SogniImageParams | SogniVideoParams): Promise<SogniProject>;
  };
}

const APP_ID_FILE = "sogni-app-id.txt";

let instancePromise: Promise<SogniClient> | null = null;

/**
 * Stable appId. Sogni wants one per installation across restarts; an env var
 * wins, otherwise a generated UUID is persisted next to the media cache so
 * restarts don't stack up stale registrations.
 */
async function resolveAppId(): Promise<string> {
  const env = getStudioEnv();
  if (env.sogniAppId) return env.sogniAppId;

  const file = path.join(env.mediaCacheDir, APP_ID_FILE);
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch {
    // First run — create one below.
  }
  const appId = randomUUID();
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, appId, "utf8");
  } catch {
    // Best-effort persistence; a fresh id per process still works.
  }
  return appId;
}

export async function getSogniClient(): Promise<SogniClient> {
  if (instancePromise) return instancePromise;

  instancePromise = (async () => {
    const env = getStudioEnv();
    if (!env.sogniApiKey) {
      // Unreachable through the provider (it checks isConfigured first);
      // guards the lazy import anyway.
      throw new Error("Sogni API key is not configured.");
    }
    const appId = await resolveAppId();
    const { SogniClient } = await import("@sogni-ai/sogni-client");
    const client = await SogniClient.createInstance({
      appId,
      apiKey: env.sogniApiKey,
      network: "fast",
      appSource: "perabyte-studio",
      // Headless proxy client: skip live swarm/availability chatter.
      socketEventSubscriptions: { modelAvailability: false },
      restEndpoint: env.sogniRestUrl,
      socketEndpoint: env.sogniSocketUrl,
      logLevel: "warn",
    });
    return client as SogniClient;
  })();

  // A failed creation must not poison the memo: the next call retries.
  instancePromise.catch(() => {
    instancePromise = null;
  });
  return instancePromise;
}

/** Test hook: swap the client (and memoised creation promise). */
export function setSogniClientForTests(client: SogniClient | null): void {
  instancePromise = client
    ? Promise.resolve(client)
    : null;
}
