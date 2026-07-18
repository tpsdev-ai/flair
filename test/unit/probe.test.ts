// probe.test.ts — Unit tests for probeInstance (src/probe.ts, flair#635).
//
// Every check here mocks fetchImpl / authedGet — no real network, no spawned
// Harper. The real-instance round trip (health + auth + version reported by
// resources/health.ts) is covered by test/integration/probe-instance.test.ts.
import { describe, test, expect } from "bun:test";
import { probeInstance, DEFAULT_PROBE_VERSION_PATH } from "../../src/probe";

/** Returns a fetchImpl that replays `responses` in order (last one repeats past the end). */
function fakeFetch(responses: Array<{ ok: boolean; status?: number } | Error>): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500) } as Response;
  }) as unknown as typeof fetch;
}

const healthyFetch = () => fakeFetch([{ ok: true }]);

describe("probeInstance — health polling", () => {
  test("healthy on first try, no authedGet given → health-only result", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", { fetchImpl: healthyFetch() });
    expect(result.healthy).toBe(true);
    expect(result.authenticated).toBeNull();
    expect(result.version).toBeNull();
    expect(result.versionMatch).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("retries through transient failures, then succeeds", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: fakeFetch([{ ok: false, status: 502 }, { ok: false, status: 502 }, { ok: true }]),
      pollIntervalMs: 1,
    });
    expect(result.healthy).toBe(true);
    expect(result.ok).toBe(true);
  });

  test("never becomes healthy within the timeout → unhealthy, clear error naming /Health", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: fakeFetch([{ ok: false, status: 502 }]),
      timeoutMs: 20,
      pollIntervalMs: 5,
    });
    expect(result.healthy).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.authenticated).toBeNull();
    expect(result.version).toBeNull();
    expect(result.versionMatch).toBeNull();
    expect(result.error).toContain("did not answer");
    expect(result.error).toContain("/Health");
  });

  test("network errors during the health poll are tolerated until the timeout, then surfaced", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: fakeFetch([new Error("ECONNREFUSED")]),
      timeoutMs: 15,
      pollIntervalMs: 5,
    });
    expect(result.healthy).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  test("unhealthy instance never calls authedGet (no wasted/misleading auth attempt)", async () => {
    let called = false;
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: fakeFetch([{ ok: false, status: 500 }]),
      timeoutMs: 10,
      pollIntervalMs: 5,
      authedGet: async () => { called = true; return { version: "1.0.0" }; },
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe("probeInstance — authenticated version check", () => {
  test("authenticated + version matches expectVersion → ok, no error", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      expectVersion: "1.2.3",
      authedGet: async () => ({ version: "1.2.3" }),
    });
    expect(result.healthy).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.version).toBe("1.2.3");
    expect(result.versionMatch).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("authenticated but version mismatch → not ok, error names both versions", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      expectVersion: "1.2.3",
      authedGet: async () => ({ version: "1.2.2" }),
    });
    expect(result.ok).toBe(false);
    expect(result.authenticated).toBe(true);
    expect(result.versionMatch).toBe(false);
    expect(result.error).toContain("version mismatch");
    expect(result.error).toContain("1.2.3");
    expect(result.error).toContain("1.2.2");
  });

  test("no expectVersion given → versionMatch stays null even though authenticated succeeded", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      authedGet: async () => ({ version: "1.2.3" }),
    });
    expect(result.authenticated).toBe(true);
    expect(result.version).toBe("1.2.3");
    expect(result.versionMatch).toBeNull();
    expect(result.ok).toBe(true);
  });

  test("authedGet rejects (e.g. bad credentials) → authenticated false, ok false, no version leaked", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      expectVersion: "1.2.3",
      authedGet: async () => { throw new Error("403 forbidden"); },
    });
    expect(result.healthy).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.version).toBeNull();
    expect(result.versionMatch).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("403 forbidden");
  });

  test("authenticated success → authFailureKind is null (nothing failed)", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      authedGet: async () => ({ version: "1.0.0" }),
    });
    expect(result.authFailureKind).toBeNull();
  });

  test("authedGet succeeds but the body carries no version field → version null, mismatch if one was expected", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      expectVersion: "1.2.3",
      authedGet: async () => ({ ok: true }),
    });
    expect(result.authenticated).toBe(true);
    expect(result.version).toBeNull();
    expect(result.versionMatch).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown");
  });

  test("defaults to GET /HealthDetail for the authenticated leg", async () => {
    let seenPath = "";
    await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      authedGet: async (path) => { seenPath = path; return { version: "1.0.0" }; },
    });
    expect(seenPath).toBe(DEFAULT_PROBE_VERSION_PATH);
    expect(DEFAULT_PROBE_VERSION_PATH).toBe("/HealthDetail");
  });

  test("custom versionPath is passed through to authedGet (for #636 fleet reuse)", async () => {
    let seenPath = "";
    await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      versionPath: "/CustomHealth",
      authedGet: async (path) => { seenPath = path; return { version: "1.0.0" }; },
    });
    expect(seenPath).toBe("/CustomHealth");
  });

  test("trailing slash on baseUrl doesn't produce a double slash", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: any) => { seenUrl = String(url); return { ok: true, status: 200 } as Response; }) as unknown as typeof fetch;
    await probeInstance("http://127.0.0.1:9999/", { fetchImpl });
    expect(seenUrl).toBe("http://127.0.0.1:9999/Health");
  });
});

// ─── authFailureKind classification (flair#741 fix #3) ────────────────────
//
// A responding server that rejects the verifier's credentials (401/403)
// proves liveness — it must be distinguishable from a genuine "can't tell
// what state this instance is in" failure (network error, timeout, 5xx).
// probeInstance reads a numeric `.status` off whatever authedGet throws
// (duck-typed — no dependency on a concrete error class) to make that call.

class StatusError extends Error {
  constructor(readonly status: number, message = "boom") {
    super(message);
  }
}

describe("probeInstance — authFailureKind classification (flair#741)", () => {
  test("authedGet throws with .status = 403 → authFailureKind 'credentials'", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      authedGet: async () => { throw new StatusError(403, "HTTP 403: no credentials sent"); },
    });
    expect(result.healthy).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.authFailureKind).toBe("credentials");
  });

  test("authedGet throws with .status = 401 → authFailureKind 'credentials'", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      authedGet: async () => { throw new StatusError(401, "unauthorized"); },
    });
    expect(result.authFailureKind).toBe("credentials");
  });

  test("authedGet throws with .status = 500 → authFailureKind 'server' (not credential-shaped)", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      authedGet: async () => { throw new StatusError(500, "internal error"); },
    });
    expect(result.authFailureKind).toBe("server");
  });

  test("authedGet throws a plain network error with no .status → authFailureKind 'server' (conservative default)", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      authedGet: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(result.authFailureKind).toBe("server");
  });

  test("unhealthy instance (never reaches authedGet) → authFailureKind null, not 'server'", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: fakeFetch([{ ok: false, status: 500 }]),
      timeoutMs: 10,
      pollIntervalMs: 5,
      authedGet: async () => ({ version: "1.0.0" }),
    });
    expect(result.healthy).toBe(false);
    expect(result.authFailureKind).toBeNull();
  });

  test("no authedGet given (health-only probe) → authFailureKind null", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", { fetchImpl: healthyFetch() });
    expect(result.authFailureKind).toBeNull();
  });

  test("authenticated but version mismatch → authFailureKind stays null (not an auth failure at all)", async () => {
    const result = await probeInstance("http://127.0.0.1:9999", {
      fetchImpl: healthyFetch(),
      expectVersion: "1.2.3",
      authedGet: async () => ({ version: "1.2.2" }),
    });
    expect(result.versionMatch).toBe(false);
    expect(result.authFailureKind).toBeNull();
  });
});
