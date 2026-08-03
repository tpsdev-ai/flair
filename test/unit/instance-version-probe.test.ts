// flair#1072 — `doctor` claimed the LOCAL CLI version was "current" while
// pointed at a remote instance five minors behind. Every other line it printed
// about that target was genuinely remote; the one that mattered was about the
// operator's laptop.
//
// The load-bearing rule here is the NEGATIVE one: when the instance version
// cannot be determined, this must return null so the caller says "unknown".
// Falling back to the local version is the defect, and an older instance that
// does not expose its version is exactly where that fallback is most tempting.
import { describe, test, expect } from "bun:test";
import { probeInstanceVersion } from "../../src/version-check.js";

function fakeFetch(status: number, body: unknown, delayMs = 0): typeof fetch {
  return (async (_url: string, init?: { signal?: AbortSignal }) => {
    if (delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
      });
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("probeInstanceVersion — reports the INSTANCE, or null", () => {
  test("returns the version the instance reports", async () => {
    const v = await probeInstanceVersion("https://x.invalid", 5000, fakeFetch(200, { ok: true, version: "0.30.0" }));
    expect(v).toBe("0.30.0");
  });

  test("trailing slashes on the base URL do not break the probe", async () => {
    const v = await probeInstanceVersion("https://x.invalid///", 5000, fakeFetch(200, { ok: true, version: "0.31.1" }));
    expect(v).toBe("0.31.1");
  });

  // ─── The negative cases. Each must yield null, never a fallback. ───────────

  test("null when the instance is unreachable", async () => {
    const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await probeInstanceVersion("https://x.invalid", 5000, boom)).toBeNull();
  });

  test("null on a non-2xx response", async () => {
    expect(await probeInstanceVersion("https://x.invalid", 5000, fakeFetch(503, {}))).toBeNull();
  });

  test("null when the payload carries no version — an older instance", async () => {
    expect(await probeInstanceVersion("https://x.invalid", 5000, fakeFetch(200, { ok: true }))).toBeNull();
  });

  test("null on a non-semver marker like 'dev'", async () => {
    // A Fabric peer mid-failed-deploy reports exactly this (harper#2061). It is
    // a real answer from a real server and still cannot be compared against a
    // published version — so it is undeterminable, not a version.
    expect(await probeInstanceVersion("https://x.invalid", 5000, fakeFetch(200, { ok: true, version: "dev" }))).toBeNull();
  });

  test("null when the body is not an object", async () => {
    expect(await probeInstanceVersion("https://x.invalid", 5000, fakeFetch(200, "not json"))).toBeNull();
  });

  test("null on timeout rather than hanging doctor", async () => {
    const v = await probeInstanceVersion("https://x.invalid", 20, fakeFetch(200, { version: "1.0.0" }, 500));
    expect(v).toBeNull();
  });

  test("NEVER returns the local package version as a fallback", async () => {
    // The regression this whole file exists to prevent. Every undeterminable
    // case must be null; a caller substituting its own version is the bug.
    const undeterminable = [
      fakeFetch(200, { ok: true }),
      fakeFetch(500, {}),
      fakeFetch(200, { ok: true, version: "dev" }),
    ];
    for (const f of undeterminable) {
      const v = await probeInstanceVersion("https://x.invalid", 5000, f);
      expect(v).toBeNull();
    }
  });
});
