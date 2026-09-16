/**
 * Custom providers live smoke — exercises the full generic-provider flow
 * against the apikey.fan relay (OpenAI format) using the stored env key:
 *
 *   1. Register a custom provider (openai format) via /api/settings.
 *   2. Discover its models server-side; assert kind guesses.
 *   3. Assert the custom image model shows up in the composer catalog.
 *   4. Render one small image through the durable job engine.
 *   5. Enhance a prompt through the custom text engine.
 *   6. Remove the provider and restore the enhance task model.
 *
 *   node scripts/verify-custom-providers.mjs [baseUrl]
 *
 * Google/Anthropic formats are contract-tested only (no live keys) — they
 * skip here by design. Costs: one small Grok image + one tiny chat call.
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:3100";
const { readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const path = await import("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(pathName, opts) {
  const res = await fetch(`${BASE}${pathName}`, opts);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function waitFor(fn, timeoutMs, everyMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  return null;
}
const results = [];
function check(name, ok, detail = "") {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Read the relay key from the worktree's .env.local (never printed).
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
const envText = readFileSync(envPath, "utf-8");
const keyLine = envText.split("\n").find((l) => l.startsWith("APIKEY_FAN_API_KEY="));
const API_KEY = keyLine?.slice("APIKEY_FAN_API_KEY=".length).trim() ?? "";
check("relay key found in .env.local", API_KEY.length > 10 && !API_KEY.startsWith("ss//"), `length ${API_KEY.length}`);

const PROVIDER_ID = "verify-relay";
const settingsPatch = (patch) =>
  api("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

// ---- 1. Register the custom provider ------------------------------------
const upsert = await settingsPatch({
  customProviders: {
    upsert: {
      id: PROVIDER_ID,
      label: "Verify Relay",
      format: "openai",
      baseUrl: "https://apikey.fan/v1",
      apiKey: API_KEY,
      enabled: true,
      models: [],
    },
  },
});
check("provider registered", upsert.status === 200, `status ${upsert.status}`);
const saved = upsert.body?.customProviders?.find((p) => p.id === PROVIDER_ID);
check("payload includes custom provider", Boolean(saved), saved ? saved.format : "missing");

// ---- 2. Discover models ---------------------------------------------------
const discovered = await api("/api/providers/discover", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: PROVIDER_ID }),
});
check("discovery succeeded", discovered.status === 200, `status ${discovered.status}`);
const models = discovered.body?.models ?? [];
check("models discovered", models.length >= 5, `${models.length} models`);
const byModel = Object.fromEntries(models.map((m) => [m.model, m]));
check(
  "grok-imagine-image classified as image",
  byModel["grok-imagine-image"]?.kind === "image",
  byModel["grok-imagine-image"]?.kind ?? "missing",
);
check(
  "grok-imagine-video-1.5 classified as video",
  byModel["grok-imagine-video-1.5"]?.kind === "video",
  byModel["grok-imagine-video-1.5"]?.kind ?? "missing",
);
check(
  "grok-4.5 classified as text",
  byModel["grok-4.5"]?.kind === "text",
  byModel["grok-4.5"]?.kind ?? "missing",
);
check(
  "key never echoed in discovery response",
  !JSON.stringify(discovered.body).includes(API_KEY),
);

// Persist the discovered models onto the provider.
const persisted = await settingsPatch({
  customProviders: { upsert: { id: PROVIDER_ID, models } },
});
check("models persisted", persisted.status === 200);

// ---- 3. Composer catalog visibility --------------------------------------
const catalog = await api("/api/models?kind=image");
const inCatalog = catalog.body?.models?.some((m) => m.id === `${PROVIDER_ID}:grok-imagine-image`);
check("custom image model in composer catalog", Boolean(inCatalog));

// ---- 4. Real image render through the custom provider --------------------
const submitted = await api("/api/jobs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    kind: "image",
    prompt: "A tiny red paper boat on a calm blue puddle, minimal",
    aspect: "1:1",
    resolution: "720p",
    style: "Minimal Line Art",
    duration: "5s",
    count: 1,
    negativePrompt: "",
    enhance: false,
    safe: true,
    modelId: `${PROVIDER_ID}:grok-imagine-image`,
    uncensored: false,
  }),
});
check("custom render submitted (202)", submitted.status === 202, `status ${submitted.status}`);
const jobId = submitted.body?.job?.id;
check("job id issued", Boolean(jobId), jobId ?? "");

const finished = await waitFor(async () => {
  if (!jobId) return { done: true, failed: "no job id" };
  const { body } = await api(`/api/jobs/${jobId}`);
  const status = body?.job?.status;
  if (status === "completed") return { done: true, body };
  if (status === "failed") return { done: true, failed: body?.job?.error ?? "failed" };
  return null;
}, 150_000);
check(
  "custom image render completed",
  Boolean(finished?.body) && !finished?.failed,
  finished?.failed ?? finished?.body?.job?.assets?.length + " asset(s)",
);

// ---- 5. Enhance through the custom text engine ---------------------------
await settingsPatch({ tasks: { enhance: `${PROVIDER_ID}:grok-4.5` } });
const enhanced = await api("/api/enhance", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: "a red apple", kind: "image" }),
});
check(
  "enhance ran through the custom text engine",
  enhanced.status === 200 && enhanced.body?.source === "ai",
  `source ${enhanced.body?.source}`,
);

// ---- 6. Cleanup -----------------------------------------------------------
const restored = await settingsPatch({
  customProviders: { remove: PROVIDER_ID },
  tasks: { enhance: null },
});
check("cleanup (provider removed, task model reset)", restored.status === 200);
const afterRemove = await api(`/api/models?kind=image`);
check(
  "custom models left the catalog",
  !afterRemove.body?.models?.some((m) => m.id?.startsWith(`${PROVIDER_ID}:`)),
);

const pass = results.every(Boolean);
console.log(pass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(pass ? 0 : 1);
