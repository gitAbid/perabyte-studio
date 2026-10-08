#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const DEFAULT_STATE_PATH = 'docs/production/SESSION_STATE.json';

function usage() {
  return 'Usage: node scripts/verify-production-handover.mjs [state.json] [--usage snapshot.json]';
}

function parseArgs(args) {
  let statePath = DEFAULT_STATE_PATH;
  let usagePath = null;
  let sawStatePath = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--usage') {
      if (usagePath !== null || !args[index + 1] || args[index + 1].startsWith('--')) {
        throw new Error('invalid --usage argument');
      }
      usagePath = args[++index];
    } else if (arg.startsWith('--')) {
      throw new Error('unknown option');
    } else if (!sawStatePath) {
      statePath = arg;
      sawStatePath = true;
    } else {
      throw new Error('too many paths');
    }
  }
  return { statePath, usagePath };
}

async function readJson(path, label) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`${label} file could not be read`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} file is not valid JSON`);
  }
}

async function loadGuard() {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const source = await readFile(new URL('../lib/production/development-guard.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error('guard transpilation failed');
  const encodedModule = Buffer.from(compiled.outputText).toString('base64');
  return import(`data:text/javascript;base64,${encodedModule}`);
}

function sanitizedEvaluation(evaluation) {
  return {
    decision: evaluation.decision,
    minimumRemainingPercent: evaluation.minimumRemainingPercent,
    reasons: evaluation.reasons,
    windows: evaluation.windows,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}. ${usage()}`);
    return 1;
  }

  let state;
  try {
    state = await readJson(options.statePath, 'handover state');
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  let guard;
  try {
    guard = await loadGuard();
  } catch {
    console.error('Guard module could not be loaded or transpiled.');
    return 1;
  }

  const stateErrors = guard.validateHandoverState(state);
  if (stateErrors.length > 0) {
    console.log(JSON.stringify({ state: 'invalid', errors: stateErrors }, null, 2));
    return 1;
  }

  if (!options.usagePath) {
    console.log(JSON.stringify({ state: 'valid' }, null, 2));
    return 0;
  }

  let snapshot;
  try {
    snapshot = await readJson(options.usagePath, 'usage snapshot');
  } catch (error) {
    console.error(error.message);
    return 4;
  }

  const policy = state.usage_policy === undefined
    ? undefined
    : {
      weeklyStopRemainingPercent: state.usage_policy?.weekly_stop_remaining_percent,
      fiveHourStopRemainingPercent: state.usage_policy?.five_hour_stop_remaining_percent,
    };
  const evaluation = guard.evaluateUsageSnapshot(snapshot, policy);
  console.log(JSON.stringify({ state: 'valid', usage: sanitizedEvaluation(evaluation) }, null, 2));
  return ({ continue: 0, checkpoint: 2, stop: 3, unknown: 4 })[evaluation.decision];
}

main().then((code) => {
  process.exitCode = code;
}).catch(() => {
  console.error('Verification failed unexpectedly.');
  process.exitCode = 1;
});
