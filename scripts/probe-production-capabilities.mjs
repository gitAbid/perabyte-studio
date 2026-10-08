#!/usr/bin/env node
// Discovery-only. This command never creates a project or estimates/submits paid work.
import { createRequire } from "node:module";
const observedAt = Date.now();
const require = createRequire(import.meta.url);
const sdkVersion = require("@sogni-ai/sogni-client/package.json").version;
const fixtureCapturedSdkVersion = "5.49.0";
const source = `@sogni-ai/sogni-client ${sdkVersion} ProjectsApi.getAvailableModels(network), ProjectsApi.getVideoAssetConfig(modelId), dist/Projects/index.d.ts and dist/Projects/createJobRequestMessage.js`;

if (process.argv.includes("--fixture")) {
  // Small offline shape fixture derived from AvailableModel in the installed SDK declarations.
  // Catalog fields only establish model id/media availability; conditioning limits remain unknown.
  const fixture = [{ id: "minimax-h3-fl2va-fp8_i2v", media: "video" }];
  console.log(JSON.stringify({ mode: "fixture-only", catalogCapture: "Offline schema fixture only; not a live availability response and not valid for production capability admission.", sdkVersion: fixtureCapturedSdkVersion, installedSdkVersion: sdkVersion, observedAt, fixtureObservedDate: "2026-10-03", source, fixture, paidCalls: [] }, null, 2));
  process.exit(0);
}

const apiKey = process.env.SOGNI_API_KEY;
if (!apiKey) {
  console.log(JSON.stringify({ mode: "discovery-unavailable", sdkVersion, observedAt, source, status: "unknown", message: "Set SOGNI_API_KEY to query the live model catalog. No credentials or live response are available; capabilities remain unknown.", paidCalls: [] }, null, 2));
  process.exitCode = 2;
} else {
  let client;
  try {
    const { SogniClient } = await import("@sogni-ai/sogni-client");
    client = await SogniClient.createInstance({ appId: "perabyte-capability-discovery", appSource: "perabyte-studio-capability-probe", apiKey, network: "fast", logLevel: "error" });
    const models = await client.projects.getAvailableModels("fast");
    console.log(JSON.stringify({ mode: "live-discovery-only", sdkVersion, observedAt: Date.now(), source, models: models.map(({ id, name, workerCount, media }) => ({ id, name, workerCount, media })), paidCalls: [] }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ mode: "discovery-unavailable", sdkVersion, observedAt: Date.now(), source, status: "unknown", message: "Live catalog discovery failed. Check the network, credentials, and SDK endpoint configuration, then retry.", paidCalls: [] }, null, 2));
    process.exitCode = 2;
  } finally {
    client?.dispose();
  }
}
