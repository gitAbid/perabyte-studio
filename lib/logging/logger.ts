/**
 * Structured, leveled logger used across the whole site (API routes,
 * services and provider adapters on the server; generation errors on the
 * client). Zero dependencies: JSON lines in production, plain lines in dev.
 *
 * Scopes: `logger.child({ requestId, provider })` returns a nested logger
 * whose context is merged into every line. Secrets are redacted from
 * context values before anything is written.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
  /** Returns an end-function that logs `message` with `durationMs`. */
  timer(message: string): (extra?: LogContext) => void;
}

const SENSITIVE_KEY =
  /authorization|api[-_]?key|token|secret|password|bearer|x-api-key/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        SENSITIVE_KEY.test(key) ||
        (typeof inner === "string" && /^sk-[^\s]{8,}/.test(inner))
          ? "[redacted]"
          : redact(inner, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && /^sk-[^\s]{8,}/.test(value)) {
    return "[redacted]";
  }
  return value;
}

function activeLevel(): LogLevel {
  const raw =
    typeof process !== "undefined" ? process.env?.LOG_LEVEL : undefined;
  const level = (raw || "info").toLowerCase();
  return level in LEVEL_ORDER ? (level as LogLevel) : "info";
}

function isProduction(): boolean {
  return typeof process !== "undefined"
    ? process.env?.NODE_ENV === "production"
    : false;
}

function write(level: LogLevel, message: string, context?: LogContext) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;
  const safe = redact(context ?? {}) as Record<string, unknown>;
  const sink =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  if (isProduction()) {
    sink(JSON.stringify({ time: new Date().toISOString(), level, message, ...safe }));
    return;
  }
  const parts = Object.entries(safe).map(
    ([key, value]) =>
      `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
  );
  const time = new Date().toISOString().slice(11, 23);
  sink(`${time} ${level.toUpperCase().padEnd(5)} ${message} ${parts.join(" ")}`.trimEnd());
}

function createLogger(base: LogContext): Logger {
  const log = (level: LogLevel, message: string, context?: LogContext) => {
    const merged = Object.keys(base).length
      ? { ...base, ...(context ?? {}) }
      : context;
    write(level, message, merged);
  };

  return {
    debug: (message, context) => log("debug", message, context),
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context),
    child: (context) => createLogger({ ...base, ...context }),
    timer: (message) => {
      const startedAt = Date.now();
      return (extra) =>
        write("info", message, { ...base, durationMs: Date.now() - startedAt, ...(extra ?? {}) });
    },
  };
}

/** Root logger. Prefer `logger.child({ … })` inside scoped modules. */
export const logger = createLogger({ app: "perabyte" });

/** Client-side mirror: keeps generation failures in the console with context. */
export function logClientEvent(message: string, context?: LogContext) {
  write("info", message, { surface: "client", ...(context ?? {}) });
}
