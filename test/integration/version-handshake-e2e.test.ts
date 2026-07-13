/**
 * version-handshake-e2e.test.ts — flair#695 §B, the CLI↔server version
 * handshake, against a REAL Harper instance. Unit coverage
 * (test/unit/version-handshake.test.ts) already exhaustively covers
 * caching/TTL/offline-tolerance with a fake fetch; this file proves the
 * two live-network pieces those fakes can't: (1) the real, unauthenticated
 * `GET /Health` genuinely reports `version` as a string (resources/health.ts's
 * extension), and (2) `checkServerHandshake` correctly flags a mismatch and
 * formats the exact nudge wording when pointed at that REAL endpoint with a
 * deliberately different CLI version.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { checkServerHandshake, formatHandshakeNudge } from "../../src/version-handshake";

let harper: HarperInstance;
let cacheDir: string;

describe("version handshake — real Harper /Health", () => {
  beforeAll(async () => {
    harper = await startHarper();
    cacheDir = mkdtempSync(join(tmpdir(), "flair-handshake-e2e-"));
  }, 120_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("GET /Health is unauthenticated and reports `version` as a non-empty string", async () => {
    const res = await fetch(`${harper.httpURL}/Health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { ok?: boolean; version?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
    expect(body.version!.length).toBeGreaterThan(0);
  });

  test("checkServerHandshake reports no mismatch when the CLI version matches the running server", async () => {
    const res = await fetch(`${harper.httpURL}/Health`);
    const body = (await res.json()) as { version: string };

    const result = await checkServerHandshake(body.version, "/some/root", harper.httpURL, { cacheDir });
    expect(result.source).toBe("network");
    expect(result.runningVersion).toBe(body.version);
    expect(result.mismatch).toBe(false);
    expect(formatHandshakeNudge(result)).toBeNull();
  });

  test("checkServerHandshake flags a mismatch and formats the exact nudge wording against the real server", async () => {
    const fakeCliVersion = "0.0.0-definitely-not-the-running-version";
    const result = await checkServerHandshake(fakeCliVersion, "/some/other/root", harper.httpURL, { cacheDir });

    expect(result.source).toBe("network");
    expect(result.mismatch).toBe(true);
    expect(result.runningVersion).toBeTruthy();

    const nudge = formatHandshakeNudge(result);
    expect(nudge).toBe(
      `flair ${fakeCliVersion} installed but server is running ${result.runningVersion} — run: flair restart`,
    );
  });

  test("a second call within the TTL for the SAME (rootPath, serverUrl) reuses the cache (no new network hit)", async () => {
    let networkCalls = 0;
    const countingFetch: typeof fetch = (async (...args: Parameters<typeof fetch>) => {
      networkCalls++;
      return fetch(...args);
    }) as typeof fetch;

    const rootPath = "/cache-reuse-root";
    await checkServerHandshake("1.0.0", rootPath, harper.httpURL, { cacheDir, fetchImpl: countingFetch });
    expect(networkCalls).toBe(1);

    await checkServerHandshake("1.0.0", rootPath, harper.httpURL, { cacheDir, fetchImpl: countingFetch });
    expect(networkCalls).toBe(1); // cache hit — no second network call
  });
});
