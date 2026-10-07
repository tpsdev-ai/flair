/**
 * peer-status.test.ts — the documented `Peer.status` CLI vocabulary is pinned
 * to the schema it documents (flair#2322; flair#2141 S3a item 6).
 *
 * `src/lib/peer-status.ts` mirrors the `Peer.status` value list in
 * `schemas/federation.graphql`. The list is PARSED from that schema comment —
 * never hand-copied — so this test fails the moment the two disagree in either
 * direction, and keeps the CLI's shared vocabulary honest.
 *
 * The membership classifier is separate from the documented list: `revoked` is
 * not a member and `active` is an `Instance.status` value, not a `Peer.status`.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PEER_STATUS,
  PEER_STATUS_VALUES,
  PEER_MEMBERSHIP_STATUSES,
  isPeerStatus,
  isPeerMemberStatus,
} from "../../src/lib/peer-status.ts";

/** The quoted status values on the `Peer.status` line of the federation schema. */
function schemaPeerStatusValues(): string[] {
  const schema = readFileSync(join(import.meta.dir, "../../schemas/federation.graphql"), "utf8");
  const line = schema.split("\n").find((l) => l.includes("status: String") && l.includes("paired"));
  if (line === undefined) throw new Error("schemas/federation.graphql has no Peer.status line");
  return [...line.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

describe("Peer.status vocabulary is pinned to schemas/federation.graphql", () => {
  it("PEER_STATUS_VALUES equals the schema comment's list, in order", () => {
    expect([...PEER_STATUS_VALUES] as string[]).toEqual(schemaPeerStatusValues());
  });

  it("the documented list and the exposed values are the same set", () => {
    const documented = schemaPeerStatusValues();
    expect(new Set(documented).size).toBe(documented.length);
    expect(([...PEER_STATUS_VALUES] as string[]).sort()).toEqual([...documented].sort());
  });
});

describe("Peer membership classification (flair#2141 item 6)", () => {
  it("the classifier admits the documented statuses only", () => {
    for (const value of PEER_STATUS_VALUES) expect(isPeerStatus(value)).toBe(true);
    expect(isPeerStatus("active")).toBe(false);
    expect(isPeerStatus(undefined)).toBe(false);
  });

  it("membership is every documented status except revoked, and never active", () => {
    expect([...PEER_MEMBERSHIP_STATUSES]).toEqual([
      PEER_STATUS.PAIRED,
      PEER_STATUS.CONNECTED,
      PEER_STATUS.DISCONNECTED,
    ]);
    expect(isPeerMemberStatus(PEER_STATUS.REVOKED)).toBe(false);
    expect(isPeerMemberStatus("active")).toBe(false);
    expect(PEER_STATUS_VALUES as readonly string[]).not.toContain("active");
  });

  it("the CLI imports the classifier and omits the retired color condition", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/commands/federation.ts"), "utf8");
    expect(src).toContain('from "../lib/peer-status.js"');
    // The retired literal: `active` used to color a peer status green.
    expect(src).not.toContain('s === "paired" || s === "connected" || s === "active"');
  });
});
