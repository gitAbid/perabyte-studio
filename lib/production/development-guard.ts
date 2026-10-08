export type UsageDecision = 'continue' | 'checkpoint' | 'stop' | 'unknown';

export type UsageWindow = {
  limitId: string;
  window: 'primary' | 'secondary';
  remainingPercent: number;
  resetAt: number | null;
};

export type UsageStopPolicy = Readonly<{
  weeklyStopRemainingPercent: number;
  fiveHourStopRemainingPercent: number;
}>;

export type UsageEvaluation = {
  decision: UsageDecision;
  minimumRemainingPercent: number | null;
  reasons: string[];
  windows: UsageWindow[];
};

const HARD_STOP_REMAINING_PERCENT = 2;
const CHECKPOINT_REMAINING_PERCENT = 5;
const WINDOW_NAMES = ['primary', 'secondary'] as const;
type WindowName = (typeof WINDOW_NAMES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asEntries(value: unknown): Array<[string, unknown]> | null {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item]);
  }
  if (isRecord(value)) return Object.entries(value);
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validStopPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isUsageStopPolicy(value: unknown): value is UsageStopPolicy {
  return isRecord(value)
    && validStopPercent(value.weeklyStopRemainingPercent)
    && validStopPercent(value.fiveHourStopRemainingPercent);
}

function usageStopPolicyFromState(value: unknown): UsageStopPolicy | null {
  if (!isRecord(value)) return null;
  const policy = {
    weeklyStopRemainingPercent: value.weekly_stop_remaining_percent,
    fiveHourStopRemainingPercent: value.five_hour_stop_remaining_percent,
  };
  return isUsageStopPolicy(policy) ? policy : null;
}

function readResetAt(bucket: Record<string, unknown>): number | null {
  const resetAt = finiteNumber(bucket.resetAt ?? bucket.resetsAt ?? bucket.reset_at);
  return resetAt;
}

function bucketEntries(snapshot: Record<string, unknown>): {
  entries: Array<{ limitId: string; bucket: unknown }>;
  malformedSource: boolean;
} {
  const newer = snapshot.rateLimitsByLimitId;
  const newerEntries = asEntries(newer);
  const hasNewerEntries = newerEntries !== null && newerEntries.length > 0;
  const malformedNonemptyNewer = newerEntries === null
    && newer !== undefined
    && newer !== null
    && newer !== '';

  if (hasNewerEntries) {
    return {
      entries: (newerEntries ?? []).map(([key, value]) => {
        const limitId = isRecord(value) && typeof value.limitId === 'string' && value.limitId.length > 0
          ? value.limitId
          : key;
        return { limitId, bucket: value };
      }),
      malformedSource: false,
    };
  }
  if (malformedNonemptyNewer) {
    return {
      entries: [],
      malformedSource: true,
    };
  }

  const legacy = snapshot.rateLimits;
  if (!isRecord(legacy)) {
    return { entries: [], malformedSource: legacy !== undefined };
  }

  const hasDirectWindows = WINDOW_NAMES.some((name) => Object.hasOwn(legacy, name));
  if (hasDirectWindows) {
    return {
      entries: [{ limitId: 'legacy', bucket: legacy }],
      malformedSource: false,
    };
  }

  const legacyEntries = Object.entries(legacy);
  if (legacyEntries.some(([, value]) => isRecord(value) && WINDOW_NAMES.some((name) => Object.hasOwn(value, name)))) {
    return {
      entries: legacyEntries.map(([limitId, bucket]) => ({ limitId, bucket })),
      malformedSource: false,
    };
  }

  return { entries: [], malformedSource: legacyEntries.length > 0 };
}

function usageControlStops(value: unknown, reasons: Set<string>): boolean {
  if (!isRecord(value)) return false;
  let stops = false;
  if (value.ordinaryUsageAllowed === false) {
    reasons.add('ordinary usage is explicitly disallowed');
    stops = true;
  }
  if (value.spendControlReached === true) {
    reasons.add('a spend control is explicitly reached');
    stops = true;
  }
  if (value.rateLimitReached === true) {
    reasons.add('a rate limit is explicitly reached');
    stops = true;
  }
  if (value.rateLimitReachedType !== undefined && value.rateLimitReachedType !== null) {
    reasons.add('a rate limit is explicitly reached');
    stops = true;
  }
  return stops;
}

/**
 * Evaluate an already-parsed account usage snapshot. Missing or malformed usage
 * data fails closed; a verified hard-stop observation wins over unknown peers.
 */
export function evaluateUsageSnapshot(snapshot: unknown, policy?: UsageStopPolicy): UsageEvaluation {
  const windows: UsageWindow[] = [];
  const reasons = new Set<string>();
  const root = isRecord(snapshot) ? snapshot : null;

  if (!root) {
    return {
      decision: 'unknown',
      minimumRemainingPercent: null,
      reasons: ['usage snapshot is not an object'],
      windows,
    };
  }

  const selected = bucketEntries(root);
  let explicitControlStop = usageControlStops(root, reasons);
  const explicitPolicy = policy !== undefined;
  const validPolicy = explicitPolicy && isUsageStopPolicy(policy) ? policy : null;
  if (explicitPolicy && validPolicy === null) reasons.add('usage stop policy is missing or invalid');
  if (selected.malformedSource) reasons.add('selected usage data is malformed');
  if (selected.entries.length === 0) reasons.add('no usage windows are available');

  let policyStopReason: string | null = null;

  selected.entries.forEach(({ limitId, bucket }) => {
    if (!isRecord(bucket)) {
      reasons.add('usage bucket is not an object');
      return;
    }
    explicitControlStop = usageControlStops(bucket, reasons) || explicitControlStop;

    WINDOW_NAMES.forEach((windowName: WindowName) => {
      const candidate = bucket[windowName];
      if (!isRecord(candidate)) {
        reasons.add(`${windowName} usage window is missing or malformed`);
        return;
      }
      explicitControlStop = usageControlStops(candidate, reasons) || explicitControlStop;

      const usedPercentValue = Object.hasOwn(candidate, 'usedPercent')
        ? candidate.usedPercent
        : candidate.used_percent;
      const usedPercent = finiteNumber(usedPercentValue);
      if (usedPercent === null || usedPercent < 0 || usedPercent > 100) {
        reasons.add(`${windowName} used percentage is missing or invalid`);
        return;
      }

      windows.push({
        limitId,
        window: windowName,
        remainingPercent: 100 - usedPercent,
        resetAt: readResetAt(candidate),
      });

      if (explicitPolicy) {
        const duration = finiteNumber(candidate.windowDurationMins);
        if (duration === null || !Number.isInteger(duration) || duration <= 0) {
          reasons.add(`${windowName} window duration is missing or invalid`);
        } else if (validPolicy !== null) {
          const threshold = duration === 10080
            ? validPolicy.weeklyStopRemainingPercent
            : duration === 300
              ? validPolicy.fiveHourStopRemainingPercent
              : HARD_STOP_REMAINING_PERCENT;
          const name = duration === 10080 ? 'weekly'
            : duration === 300 ? 'five-hour' : `${duration}-minute`;
          if (100 - usedPercent <= threshold) {
            policyStopReason = `${name} usage is at or below its ${threshold}% stop`;
          }
        }
      }
    });
  });

  const minimumRemainingPercent = windows.length > 0
    ? Math.min(...windows.map((window) => window.remainingPercent))
    : null;

  if (minimumRemainingPercent === null) {
    reasons.add('no valid remaining percentage is available');
  }

  if (explicitControlStop) {
    return {
      decision: 'stop',
      minimumRemainingPercent,
      reasons: [...reasons],
      windows,
    };
  }

  if (!explicitPolicy && minimumRemainingPercent !== null && minimumRemainingPercent <= HARD_STOP_REMAINING_PERCENT) {
    reasons.add('remaining usage is at or below the 2% hard stop');
    return {
      decision: 'stop',
      minimumRemainingPercent,
      reasons: [...reasons],
      windows,
    };
  }

  if (explicitPolicy && reasons.size > 0) {
    return {
      decision: 'unknown',
      minimumRemainingPercent,
      reasons: [...reasons],
      windows,
    };
  }

  if (policyStopReason !== null) {
    reasons.add(policyStopReason);
    return {
      decision: 'stop',
      minimumRemainingPercent,
      reasons: [...reasons],
      windows,
    };
  }

  if (reasons.size > 0) {
    return {
      decision: 'unknown',
      minimumRemainingPercent,
      reasons: [...reasons],
      windows,
    };
  }

  if (!explicitPolicy && minimumRemainingPercent !== null && minimumRemainingPercent <= CHECKPOINT_REMAINING_PERCENT) {
    return {
      decision: 'checkpoint',
      minimumRemainingPercent,
      reasons: ['remaining usage is at or below the 5% handover reserve'],
      windows,
    };
  }

  return {
    decision: 'continue',
    minimumRemainingPercent,
    reasons: [],
    windows,
  };
}

const VALID_STATES = new Set(['building', 'checkpointing', 'usage_paused', 'ready_for_resume']);
const REQUIRED_PACKET_FIELDS = [
  'id',
  'owner',
  'branch',
  'worktree',
  'base_sha',
  'head_sha',
  'status',
  'dirty_files',
  'evidence_paths',
  'next_command',
  'unverified',
] as const;
const CHECKPOINT_STATES = new Set(['checkpointing', 'usage_paused', 'ready_for_resume']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const SHA_RE = /^[a-fA-F0-9]{40}$/;

function safeString(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string'
    && value.length <= 4096
    && !CONTROL_CHARACTERS.test(value)
    && (allowEmpty || value.trim().length > 0);
}

function isAbsoluteWorktree(value: string): boolean {
  return value.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\');
}

function validateStringArray(
  value: unknown,
  field: string,
  errors: string[],
  allowEmptyItems = false,
): value is string[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of safe strings`);
    return false;
  }
  let valid = true;
  value.forEach((item, index) => {
    if (!safeString(item, allowEmptyItems)) {
      errors.push(`${field}[${index}] must be a safe string`);
      valid = false;
    }
  });
  return valid;
}

function validatePausedUsageObservation(
  value: unknown,
  errors: string[],
  policy: UsageStopPolicy | null,
  explicitPolicy: boolean,
): void {
  if (!isRecord(value)) {
    errors.push('usage_paused requires a verified last_usage_observation');
    return;
  }
  if (value.verified !== true || !safeString(value.source)) {
    errors.push('usage_paused requires a verified observation with a source');
  }

  if (explicitPolicy) {
    if (policy === null) {
      errors.push('usage_paused requires a valid usage stop policy');
      return;
    }
    if (!Array.isArray(value.windows) || value.windows.length === 0) {
      errors.push('usage_paused requires duration-tagged usage windows');
      return;
    }
    let stopped = false;
    let validWindows = true;
    value.windows.forEach((candidate) => {
      if (!isRecord(candidate)
          || !safeString(candidate.limitId)
          || (candidate.window !== 'primary' && candidate.window !== 'secondary')) {
        validWindows = false;
        return;
      }
      const remaining = candidate.remainingPercent;
      const duration = candidate.windowDurationMins;
      if (!validStopPercent(remaining)
          || typeof duration !== 'number'
          || !Number.isInteger(duration)
          || duration <= 0) {
        validWindows = false;
        return;
      }
      const threshold = duration === 10080 ? policy.weeklyStopRemainingPercent
        : duration === 300 ? policy.fiveHourStopRemainingPercent : HARD_STOP_REMAINING_PERCENT;
      if (remaining <= threshold) stopped = true;
    });
    if (!validWindows) errors.push('usage_paused requires valid duration-tagged usage windows');
    else if (!stopped) errors.push('usage_paused requires a window at or below its configured usage stop');
    return;
  }

  const remainingValues: number[] = [];
  for (const field of ['minimum_remaining_percent', 'primary_remaining_percent', 'secondary_remaining_percent'] as const) {
    const candidate = value[field];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > 100) {
      errors.push(`last_usage_observation.${field} must be between 0 and 100`);
      continue;
    }
    remainingValues.push(candidate);
  }

  if (remainingValues.length === 0) {
    errors.push('usage_paused requires at least one known remaining percentage');
  } else if (Math.min(...remainingValues) > HARD_STOP_REMAINING_PERCENT) {
    errors.push('usage_paused requires a verified observation at or below 2% remaining');
  }
}

/** Validate the version-1 local handover payload without exposing its values. */
export function validateHandoverState(state: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(state)) return ['handover state must be an object'];

  if (state.schema_version !== 1) errors.push('schema_version must be 1');
  const stateName = typeof state.state === 'string' ? state.state : '';
  if (!VALID_STATES.has(stateName)) errors.push('state must be a supported handover state');

  const explicitUsagePolicy = Object.hasOwn(state, 'usage_policy');
  const usagePolicy = explicitUsagePolicy ? usageStopPolicyFromState(state.usage_policy) : null;
  if (explicitUsagePolicy && usagePolicy === null) {
    errors.push('usage_policy must provide valid weekly and five-hour stop percentages');
  }

  const integration = state.integration;
  if (!isRecord(integration)) {
    errors.push('integration must be an object');
  } else {
    if (!safeString(integration.branch)) errors.push('integration.branch must be a safe string');
    if (!safeString(integration.worktree) || !isAbsoluteWorktree(integration.worktree)) {
      errors.push('integration.worktree must be an absolute path');
    }
  }

  if (!Array.isArray(state.active_packets)) {
    errors.push('active_packets must be an array');
  } else {
    const requiredFields = CHECKPOINT_STATES.has(stateName) ? REQUIRED_PACKET_FIELDS : [];
    const packetIds = new Set<string>();
    const worktrees = new Set<string>();
    const owners = new Set<string>();

    state.active_packets.forEach((packet, index) => {
      const prefix = `active_packets[${index}]`;
      if (!isRecord(packet)) {
        errors.push(`${prefix} must be an object`);
        return;
      }

      for (const field of requiredFields) {
        if (!Object.hasOwn(packet, field)) errors.push(`${prefix}.${field} is required at checkpoint`);
      }

      for (const field of ['id', 'owner', 'branch', 'status'] as const) {
        if (Object.hasOwn(packet, field) && !safeString(packet[field])) {
          errors.push(`${prefix}.${field} must be a safe string`);
        }
      }

      if (typeof packet.owner === 'string' && packet.owner.trim().length > 0) {
        const normalizedOwner = packet.owner.trim().toLowerCase();
        if (owners.has(normalizedOwner)) errors.push('active packet owners must be unique by owner');
        owners.add(normalizedOwner);
      }

      if (typeof packet.id === 'string' && packet.id.length > 0) {
        if (packetIds.has(packet.id)) errors.push('active packet ids must be unique by id');
        packetIds.add(packet.id);
      }

      if (Object.hasOwn(packet, 'worktree')) {
        if (!safeString(packet.worktree) || !isAbsoluteWorktree(packet.worktree)) {
          errors.push(`${prefix}.worktree must be an absolute path`);
        } else {
          const normalized = /^[A-Za-z]:[\\/]|^\\\\/.test(packet.worktree)
            ? packet.worktree.toLowerCase().replaceAll('/', '\\')
            : packet.worktree.replace(/\/+$/, '');
          if (worktrees.has(normalized)) errors.push('active packet worktrees must be unique by worktree');
          worktrees.add(normalized);
        }
      }

      for (const field of ['base_sha', 'head_sha'] as const) {
        if (Object.hasOwn(packet, field) && (typeof packet[field] !== 'string' || !SHA_RE.test(packet[field]))) {
          errors.push(`${prefix}.${field} must be a 40-character hexadecimal SHA`);
        }
      }

      for (const field of ['dirty_files', 'evidence_paths', 'next_command', 'unverified'] as const) {
        if (Object.hasOwn(packet, field)) {
          validateStringArray(packet[field], `${prefix}.${field}`, errors, field === 'next_command');
        }
      }
      if (CHECKPOINT_STATES.has(stateName) && Array.isArray(packet.next_command)
          && (packet.next_command.length === 0 || !safeString(packet.next_command[0]))) {
        errors.push(`${prefix}.next_command argv[0] must be a nonblank executable`);
      }

      if (packet.status === 'accepted' || packet.status === 'done') {
        if (!Array.isArray(packet.evidence_paths) || packet.evidence_paths.length === 0) {
          errors.push(`${prefix} accepted/done status requires evidence_paths`);
        }
        if (!Array.isArray(packet.unverified) || packet.unverified.length > 0) {
          errors.push(`${prefix} accepted/done status requires an empty unverified list`);
        }
      }
    });
  }

  if (stateName === 'usage_paused') {
    validatePausedUsageObservation(state.last_usage_observation, errors, usagePolicy, explicitUsagePolicy);
  }

  return errors;
}
