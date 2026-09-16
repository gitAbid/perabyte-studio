/**
 * Phase B live smoke — real Sogni render through the durable job engine.
 * Submits a solo image job, checks /api/jobs visibility mid-render, and
 * verifies the server-side History absorption on completion.
 *
 *   node scripts/verify-phaseb-jobs.mjs http://127.0.0.1:3000
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts) {
  const res = await fetch(`${BASE}${path}`, opts);
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

// Submit a real Sogni render as a durable job.
const submitted = await api("/api/jobs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    kind: "image",
    prompt: "A brass diving helmet resting on coral, sun rays through turquoise water",
    aspect: "16:9",
    resolution: "1080p",
    style: "Realistic",
    duration: "5s",
    count: 1,
    negativePrompt: "",
    enhance: false,
    safe: true,
    modelId: "sogni:krea2_turbo_fp8_scaled",
    uncensored: false,
  }),
});
check("job submitted (202)", submitted.status === 202, `status ${submitted.status}`);
const jobId = submitted.body?.job?.id;
check("job id issued", Boolean(jobId), jobId ?? "");

const running = await waitFor(async () => {
  const { body } = await api(`/api/jobs/${jobId}`);
  return body?.job?.providerRef ? body.job : null;
}, 45_000);
check("providerRef persisted while running", Boolean(running?.providerRef), running?.providerRef ?? "none");
check("progress ticking", Boolean(running?.progress), running?.progress?.message ?? "");

const activeList = await api("/api/jobs");
check("active list includes the job", Boolean(activeList.body?.jobs?.some((j) => j.id === jobId)));

const completed = await waitFor(async () => {
  const { body } = await api(`/api/jobs/${jobId}`);
  return body?.job?.status === "completed" ? body.job : null;
}, 240_000);
check("job completed", Boolean(completed), completed?.status ?? "timeout");
check("result media cached on origin", Boolean(completed?.result?.[0]?.url?.startsWith("/api/media")), completed?.result?.[0]?.url ?? "");

const assets = await api("/api/assets");
const absorbed = assets.body?.assets?.find((a) => a.id === `a_${jobId}`);
check("server-side History absorption", Boolean(absorbed), absorbed ? absorbed.id : "missing");

console.log(`\nJOB_ID=${jobId}`);
process.exit(results.every(Boolean) ? 0 : 1);
