/**
 * federation-peer-liveness.test.ts — flair#1499
 *
 * HealthDetail used to count `status === "connected"` (pairing writes
 * `paired`) and then take the oldest lastSyncAt including revoked rows.
 * A hub paired + synced a minute ago plus a revoked June row fired
 * "federation peers all disconnected >24h".
 *
 * Three contact states, not two: (a) recent lastSyncAt → connected;
 * (b) real last-contact >24h → disconnected; (c) no timestamp → unknown,
 * never (b). Revoked peers never drive the warning.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  FEDERATION_PEERS_ALL_DISCONNECTED_WARNING,
  PEER_STALE_MS,
  classifyPeerLiveness,
  federationPeersAllDisconnectedWarning,
  parseLastContactMs,
  summarizePeerLiveness,
} from "../../resources/federation-peer-liveness.js";

const NOW = Date.parse("2026-09-03T06:44:56.000Z");
const MINUTE_AGO = "2026-09-03T06:43:56.000Z";
const JUNE = "2026-06-11T00:00:00.000Z";
const EXACTLY_24H = new Date(NOW - PEER_STALE_MS).toISOString();
const JUST_OVER_24H = new Date(NOW - PEER_STALE_MS - 1).toISOString();

describe("parseLastContactMs", () => {
  test("parses a written ISO stamp", () => {
    expect(parseLastContactMs(MINUTE_AGO)).toBe(Date.parse(MINUTE_AGO));
  });

  test("missing / empty / whitespace is no timestamp, not epoch", () => {
    expect(parseLastContactMs(null)).toBeNull();
    expect(parseLastContactMs(undefined)).toBeNull();
    expect(parseLastContactMs("")).toBeNull();
    expect(parseLastContactMs("   ")).toBeNull();
  });

  test("unparseable and non-string values are no timestamp", () => {
    expect(parseLastContactMs("not-a-date")).toBeNull();
    expect(parseLastContactMs(0)).toBeNull();
    expect(parseLastContactMs(NOW)).toBeNull();
  });
});

describe("classifyPeerLiveness", () => {
  test("(a) paired + lastSyncAt within the window → connected", () => {
    expect(classifyPeerLiveness({ status: "paired", lastSyncAt: MINUTE_AGO }, NOW)).toBe("connected");
  });

  test("(a) stored status 'disconnected' with a fresh lastSyncAt is still connected", () => {
    expect(classifyPeerLiveness({ status: "disconnected", lastSyncAt: MINUTE_AGO }, NOW)).toBe("connected");
  });

  test("(a) future lastSyncAt (clock skew) is connected, not stale", () => {
    expect(classifyPeerLiveness({ status: "paired", lastSyncAt: "2026-09-03T07:00:00.000Z" }, NOW)).toBe("connected");
  });

  test("(a) exactly 24h ago is still connected (strictly older than the window is disconnected)", () => {
    expect(classifyPeerLiveness({ status: "paired", lastSyncAt: EXACTLY_24H }, NOW)).toBe("connected");
  });

  test("(b) real last-contact older than 24h → disconnected", () => {
    expect(classifyPeerLiveness({ status: "paired", lastSyncAt: JUST_OVER_24H }, NOW)).toBe("disconnected");
    expect(classifyPeerLiveness({ status: "connected", lastSyncAt: JUNE }, NOW)).toBe("disconnected");
  });

  test("(c) no timestamp → unknown, never disconnected", () => {
    expect(classifyPeerLiveness({ status: "paired" }, NOW)).toBe("unknown");
    expect(classifyPeerLiveness({ status: "connected", lastSyncAt: null }, NOW)).toBe("unknown");
    expect(classifyPeerLiveness({ status: "disconnected", lastSyncAt: "" }, NOW)).toBe("unknown");
    expect(classifyPeerLiveness({ status: "paired", lastSyncAt: "bogus" }, NOW)).toBe("unknown");
  });

  test("revoked is revoked regardless of lastSyncAt", () => {
    expect(classifyPeerLiveness({ status: "revoked", lastSyncAt: JUNE }, NOW)).toBe("revoked");
    expect(classifyPeerLiveness({ status: "revoked", lastSyncAt: MINUTE_AGO }, NOW)).toBe("revoked");
    expect(classifyPeerLiveness({ status: "revoked" }, NOW)).toBe("revoked");
  });
});

describe("summarizePeerLiveness + warning", () => {
  test("issue #1499: paired hub synced a minute ago + revoked stale → connected, no warning", () => {
    const summary = summarizePeerLiveness(
      [
        { status: "paired", lastSyncAt: MINUTE_AGO },
        { status: "revoked", lastSyncAt: JUNE },
      ],
      NOW,
    );
    expect(summary).toEqual({
      total: 2,
      connected: 1,
      disconnected: 0,
      revoked: 1,
      unknown: 0,
      allNonRevokedDisconnected: false,
    });
    expect(federationPeersAllDisconnectedWarning(summary)).toBeNull();
  });

  test("(b) every non-revoked peer genuinely stale → warning", () => {
    const summary = summarizePeerLiveness(
      [{ status: "paired", lastSyncAt: JUNE }],
      NOW,
    );
    expect(summary.disconnected).toBe(1);
    expect(summary.allNonRevokedDisconnected).toBe(true);
    expect(federationPeersAllDisconnectedWarning(summary)).toEqual({
      level: "warn",
      message: FEDERATION_PEERS_ALL_DISCONNECTED_WARNING,
    });
  });

  test("stale non-revoked + revoked still warns — revoked exclusion is not silence", () => {
    const summary = summarizePeerLiveness(
      [
        { status: "paired", lastSyncAt: JUNE },
        { status: "revoked", lastSyncAt: MINUTE_AGO },
      ],
      NOW,
    );
    expect(summary.disconnected).toBe(1);
    expect(summary.revoked).toBe(1);
    expect(summary.allNonRevokedDisconnected).toBe(true);
    expect(federationPeersAllDisconnectedWarning(summary)?.message).toBe(
      FEDERATION_PEERS_ALL_DISCONNECTED_WARNING,
    );
  });

  test("(c) missing lastSyncAt is unknown — does not fire the >24h warning", () => {
    const summary = summarizePeerLiveness([{ status: "paired" }], NOW);
    expect(summary.unknown).toBe(1);
    expect(summary.disconnected).toBe(0);
    expect(summary.allNonRevokedDisconnected).toBe(false);
    expect(federationPeersAllDisconnectedWarning(summary)).toBeNull();
  });

  test("unknown + disconnected is not 'all disconnected'", () => {
    const summary = summarizePeerLiveness(
      [
        { status: "paired" },
        { status: "paired", lastSyncAt: JUNE },
      ],
      NOW,
    );
    expect(summary.unknown).toBe(1);
    expect(summary.disconnected).toBe(1);
    expect(summary.allNonRevokedDisconnected).toBe(false);
    expect(federationPeersAllDisconnectedWarning(summary)).toBeNull();
  });

  test("revoked-only peers do not fire the warning", () => {
    const summary = summarizePeerLiveness(
      [{ status: "revoked", lastSyncAt: JUNE }],
      NOW,
    );
    expect(summary.revoked).toBe(1);
    expect(summary.disconnected).toBe(0);
    expect(summary.allNonRevokedDisconnected).toBe(false);
    expect(federationPeersAllDisconnectedWarning(summary)).toBeNull();
  });

  test("one recent + one stale non-revoked is not 'all disconnected'", () => {
    const summary = summarizePeerLiveness(
      [
        { status: "paired", lastSyncAt: MINUTE_AGO },
        { status: "paired", lastSyncAt: JUNE },
      ],
      NOW,
    );
    expect(summary.connected).toBe(1);
    expect(summary.disconnected).toBe(1);
    expect(summary.allNonRevokedDisconnected).toBe(false);
    expect(federationPeersAllDisconnectedWarning(summary)).toBeNull();
  });

  test("empty peer list does not warn", () => {
    const summary = summarizePeerLiveness([], NOW);
    expect(summary.total).toBe(0);
    expect(summary.allNonRevokedDisconnected).toBe(false);
    expect(federationPeersAllDisconnectedWarning(summary)).toBeNull();
  });
});

describe("HealthDetail wiring (flair#1499)", () => {
  test("derives counts from lastSyncAt, not status === connected", () => {
    const src = readFileSync(join(import.meta.dir, "../../resources/health.ts"), "utf8");
    expect(src).toContain("summarizePeerLiveness");
    expect(src).toContain("federationPeersAllDisconnectedWarning");
    expect(src).toContain("classifyPeerLiveness");
    expect(src).not.toMatch(/p\.status === "connected"/);
  });
});
