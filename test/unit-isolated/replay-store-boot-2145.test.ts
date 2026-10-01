/**
 * replay-store-boot-2145.test.ts — the boot report for the XAA jti store and
 * the OAuth single-use store (flair#2145 item 2).
 *
 * Each store's owner declares its store and calls reportReplayStoreGapsAtBoot
 * during Harper's awaited resource import (resources/XAA.ts:
 * XAA_JTI_REPLAY_BOOT_STORE; resources/OAuth.ts:
 * OAUTH_SINGLE_USE_BOOT_STORE). This test imports those modules with both
 * tables missing, checks their lines before invoking a resource handler, then
 * pins each gap through the exported specs and replayStoreStoreGaps.
 *
 * Isolated lane: this file stubs `harper` for `databases` and sets the
 * `server` global, so it must run one-process-per-file (flair#1817).
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createFakeReplayNonceTable, ensureGlobalHarperTransaction, type FakeReplayNonceTable } from "../helpers/fake-replay-store.ts";

class NoopBase { constructor(_id?: any, _ctx?: any) {} }

// The report only runs on a Harper worker thread (replay-store.ts checks
// `server.workerCount`), and its deps are resolved during import, so the modules
// below are imported with the worker globals set and both stores absent.
(globalThis as any).server = { workerCount: 2 };

const flairStub: any = new Proxy({}, { get: (target: any, prop) => (prop in target ? target[prop] : NoopBase) });
const goodNonce = createFakeReplayNonceTable();
goodNonce.expirationMS = 120_000;
flairStub.ReplayNonce = goodNonce;
// Both stores are absent at the worker's boot below.
flairStub.IdJagReplay = undefined;
flairStub.OAuthSingleUse = undefined;

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  Resource: NoopBase,
  databases: { flair: flairStub },
}));

const restoreTransaction = ensureGlobalHarperTransaction();

const bootLines: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]) => bootLines.push(a.join(" "));
let rs: any;
let xaa: any;
let oauth: any;
try {
  rs = await import("../../resources/replay-store.ts");
  xaa = await import("../../resources/XAA.ts");
  oauth = await import("../../resources/OAuth.ts");
} finally {
  console.error = origError;
}

afterAll(() => {
  restoreTransaction();
  delete (globalThis as any).server;
});

/** An IdJagReplay-shaped fake whose rows outlive the longest an assertion stays acceptable. */
function goodIdJag(): FakeReplayNonceTable {
  const table = createFakeReplayNonceTable();
  table.expirationMS = xaa.ID_JAG_REPLAY_RETENTION_S * 1000;
  return table;
}

/** An OAuthSingleUse-shaped fake whose rows outlive both presentation windows. */
function goodSingleUse(): FakeReplayNonceTable {
  const table = createFakeReplayNonceTable();
  table.expirationMS = oauth.OAUTH_SINGLE_USE_RETENTION_S * 1000;
  return table;
}

/** Run `fn` with console.error captured, and return the `[flair-replay]` lines written. */
function linesAtBoot(report: () => void): string[] {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    report();
  } finally {
    console.error = orig;
  }
  return lines.filter((l) => l.includes("[flair-replay]"));
}

beforeEach(() => {
  flairStub.ReplayNonce = goodNonce;
  flairStub.IdJagReplay = goodIdJag();
  flairStub.OAuthSingleUse = goodSingleUse();
});

describe("the store modules report their store when the worker boots", () => {
  it("both stores are named during import, before a resource serves a request", async () => {
    expect(bootLines.some((l) => l.includes("ReplayStoreUnavailable at boot (XAA jti: table flair.IdJagReplay is not defined)"))).toBe(true);
    expect(bootLines.some((l) => l.includes("ReplayStoreUnavailable at boot (OAuth single-use: table flair.OAuthSingleUse is not defined)"))).toBe(true);
    expect(bootLines.some((l) => l.includes("Requests through that store are refused until it is usable"))).toBe(true);
    // Calling a real resource handler in this turn must follow those lines;
    // a timer scheduled during import would leave bootLines empty above.
    expect((await new oauth.OAuthMetadata().get()).issuer).toBeDefined();
  });
});

describe("a complete store reports no gap", () => {
  it("the XAA jti store and the OAuth single-use store are silent", async () => {
    expect(await linesAtBoot(() => rs.reportReplayStoreGapsAtBoot(xaa.XAA_JTI_REPLAY_BOOT_STORE))).toEqual([]);
    expect(await linesAtBoot(() => rs.reportReplayStoreGapsAtBoot(oauth.OAUTH_SINGLE_USE_BOOT_STORE))).toEqual([]);
  });
});

describe("a misconfigured store is named", () => {
  it("the XAA jti store: a missing table", async () => {
    flairStub.IdJagReplay = undefined;
    const lines = await linesAtBoot(() => rs.reportReplayStoreGapsAtBoot(xaa.XAA_JTI_REPLAY_BOOT_STORE));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("ReplayStoreUnavailable at boot (XAA jti: table flair.IdJagReplay is not defined)");
  });

  it("the XAA jti store: a table whose rows do not outlive an accepted assertion", async () => {
    const brief = goodIdJag();
    brief.expirationMS = xaa.ID_JAG_LONGEST_ACCEPTANCE_MS;
    flairStub.IdJagReplay = brief;
    const lines = await linesAtBoot(() => rs.reportReplayStoreGapsAtBoot(xaa.XAA_JTI_REPLAY_BOOT_STORE));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(
      `flair.IdJagReplay keeps rows ${brief.expirationMS} ms, not longer than the ${xaa.ID_JAG_LONGEST_ACCEPTANCE_MS} ms an assertion can stay acceptable`,
    );
  });

  it("the XAA jti store: a missing primary-store primitive", async () => {
    const broken = goodIdJag();
    delete (broken.primaryStore as any).tryLock;
    flairStub.IdJagReplay = broken;
    const lines = await linesAtBoot(() => rs.reportReplayStoreGapsAtBoot(xaa.XAA_JTI_REPLAY_BOOT_STORE));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("flair.IdJagReplay.primaryStore.tryLock is not a function");
  });

  it("the OAuth single-use store: a missing table", async () => {
    flairStub.OAuthSingleUse = undefined;
    const lines = await linesAtBoot(() => rs.reportReplayStoreGapsAtBoot(oauth.OAUTH_SINGLE_USE_BOOT_STORE));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("ReplayStoreUnavailable at boot (OAuth single-use: table flair.OAuthSingleUse is not defined)");
  });

  it("the OAuth single-use store: a table whose rows do not outlive the longest presentation", async () => {
    const brief = goodSingleUse();
    brief.expirationMS = oauth.OAUTH_SINGLE_USE_MIN_RETENTION_MS;
    flairStub.OAuthSingleUse = brief;
    const lines = await linesAtBoot(() => rs.reportReplayStoreGapsAtBoot(oauth.OAUTH_SINGLE_USE_BOOT_STORE));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain(
      `flair.OAuthSingleUse keeps rows ${brief.expirationMS} ms, not longer than the ${oauth.OAUTH_SINGLE_USE_MIN_RETENTION_MS} ms a redeemed authorization code or refresh token can be presented`,
    );
  });
});

describe("the store specs the two modules declare", () => {
  it("name their store, resolve its table, and carry its retention minimum", () => {
    expect(xaa.XAA_JTI_REPLAY_BOOT_STORE.label).toBe("XAA jti");
    expect(xaa.XAA_JTI_REPLAY_BOOT_STORE.deps().name).toBe("IdJagReplay");
    expect(xaa.XAA_JTI_REPLAY_BOOT_STORE.minRetentionMs).toBe(xaa.ID_JAG_LONGEST_ACCEPTANCE_MS);
    expect(oauth.OAUTH_SINGLE_USE_BOOT_STORE.label).toBe("OAuth single-use");
    expect(oauth.OAUTH_SINGLE_USE_BOOT_STORE.deps().name).toBe("OAuthSingleUse");
    expect(oauth.OAUTH_SINGLE_USE_BOOT_STORE.minRetentionMs).toBe(oauth.OAUTH_SINGLE_USE_MIN_RETENTION_MS);
  });
});
