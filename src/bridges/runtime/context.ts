/**
 * Minimal BridgeContext implementation for slice 2.
 *
 * Slice 2 bridges only exercise the YAML/declarative runtime, which doesn't
 * hit ctx.fetch or ctx.cache. But the types and the contract must exist so
 * slice-3 code-plugin bridges can drop in against the same object shape.
 *
 * Implementation is intentionally simple here:
 *   - fetch is a thin passthrough to global fetch (slice 3 adds the token
 *     bucket + rate-limiting + audit tap)
 *   - log writes to stderr with structured JSON so the operator can redirect
 *     and an agent caller can grep
 *   - cache is in-memory for the invocation (persisted cache lands later)
 */

import type { BridgeContext } from "../types.js";

export interface MakeContextOptions {
  bridge: string;
  /** How to emit log events. Defaults to stderr-JSON. Tests inject a buffer. */
  emit?: (event: LogEvent) => void;
}

export interface LogEvent {
  bridge: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
  timestamp: string;
}

const DEFAULT_EMIT = (ev: LogEvent): void => {
  // One JSON object per line; stderr so stdout stays clean for bridge output
  process.stderr.write(JSON.stringify(ev) + "\n");
};

export function makeContext(opts: MakeContextOptions): BridgeContext {
  const emit = opts.emit ?? DEFAULT_EMIT;
  const cache = new Map<string, { value: string; expiresAt: number | null }>();

  const log = (level: LogEvent["level"]) => (message: string, meta?: Record<string, unknown>): void => {
    emit({
      bridge: opts.bridge,
      level,
      message,
      meta,
      timestamp: new Date().toISOString(),
    });
  };

  return {
    fetch: (input, init) => fetch(input, init),
    log: {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    cache: {
      async get(key) {
        const entry = cache.get(key);
        if (!entry) return null;
        if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
          cache.delete(key);
          return null;
        }
        return entry.value;
      },
      async set(key, value, ttlSeconds) {
        const expiresAt = ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : null;
        cache.set(key, { value, expiresAt });
      },
      async del(key) {
        cache.delete(key);
      },
    },
  };
}
