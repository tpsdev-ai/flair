/**
 * federation-pair-identity.test.ts — flair#822
 *
 * Chip: fail-closed on the spoke. Pair already returns
 * `instance.{id,publicKey}` when the hub has a FederationInstance row
 * (flair#213). An empty spoke hub-Peer key means that row was missing
 * (#839). Never store `""`. Do not GET `/FederationInstance` — that
 * path is admin-gated and find-or-creates a hub row.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_HUB_PEER_KEY_ERROR,
  hubPeerFromPairResult,
  resolveHubPeerIdentity,
} from "../../src/lib/federation-pair-identity.ts";

const HUB_ID = "flair_hubdeadbeef";
const HUB_KEY = "dGVzdC1lZDI1NTE5LXB1YmtleS1iYXNlNjR1cmw";

function pairActionSource(): string {
  const src = readFileSync(join(import.meta.dir, "../../src/cli.ts"), "utf8");
  const start = src.indexOf('.command("pair <hub-url>")');
  const end = src.indexOf('federation\n  .command("token")', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("pair response — instance.{id,publicKey} is accepted", () => {
  it("accepts the shape pair has returned since flair#213", () => {
    const result = hubPeerFromPairResult({
      paired: true,
      instance: { id: HUB_ID, publicKey: HUB_KEY, role: "hub" },
    });
    expect(result).toEqual({ ok: true, peer: { id: HUB_ID, publicKey: HUB_KEY } });
  });
});

describe("spoke refuse-empty — never store publicKey:\"\"", () => {
  it("refuses instance:null / omitted instance (the #839-at-pair-time path)", () => {
    for (const body of [{ paired: true, instance: null }, { paired: true }, null, undefined, {}]) {
      const result = hubPeerFromPairResult(body);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("missing_public_key");
    }
  });

  it("refuses publicKey:\"\" and whitespace — do not fill and call it done", () => {
    for (const publicKey of ["", "   "]) {
      const result = hubPeerFromPairResult({
        instance: { id: HUB_ID, publicKey },
      });
      expect(result.ok).toBe(false);
    }
  });

  it("keeps a present publicKey even when id is missing (id falls back to \"hub\")", () => {
    const result = hubPeerFromPairResult({ instance: { publicKey: HUB_KEY } });
    expect(result).toEqual({ ok: true, peer: { id: "hub", publicKey: HUB_KEY } });
  });
});

describe("resolveHubPeerIdentity — ERROR, never \"\"", () => {
  it("uses the pair response when instance.publicKey is present", () => {
    expect(resolveHubPeerIdentity({ instance: { id: HUB_ID, publicKey: HUB_KEY } })).toEqual({
      ok: true,
      source: "pair",
      peer: { id: HUB_ID, publicKey: HUB_KEY },
    });
  });

  it("errors when pair lacks publicKey — never fill \"\"", () => {
    const resolved = resolveHubPeerIdentity({ instance: { id: "hub", publicKey: "" } });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(EMPTY_HUB_PEER_KEY_ERROR);
    expect(resolved.error).toContain("flair#839");
    expect(resolved.error).toContain("does not create one");
  });

  it("errors when instance is null", () => {
    const resolved = resolveHubPeerIdentity({ paired: true, instance: null });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(EMPTY_HUB_PEER_KEY_ERROR);
  });
});

describe("wiring — spoke fail-closed; no FederationInstance fetch", () => {
  const root = join(import.meta.dir, "../..");

  it("FederationPair.post still returns instance.{id,publicKey} from the Instance row (flair#213)", () => {
    const src = readFileSync(join(root, "resources/Federation.ts"), "utf8");
    expect(src).toContain("id: ourInstance.id");
    expect(src).toContain("publicKey: ourInstance.publicKey");
    expect(src).toMatch(/instance:\s*ourInstance\s*\?/);
    expect(src).not.toContain("HUB_IDENTITY_INCOMPLETE");
    expect(src).not.toContain("pairResponseInstance");
  });

  it("spoke pair writes resolvedHub.peer.publicKey and never ?? \"\" or GET /FederationInstance", () => {
    const pairSrc = pairActionSource();
    expect(pairSrc).toContain("resolveHubPeerIdentity");
    expect(pairSrc).toContain("resolvedHub.peer.publicKey");
    expect(pairSrc).toContain("resolvedHub.peer.id");
    expect(pairSrc).not.toMatch(/publicKey:\s*result\.instance\?\.publicKey\s*\?\?\s*""/);
    expect(pairSrc).not.toContain("fetchInstance");
    expect(pairSrc).not.toMatch(/fetch\(`\$\{hubBase\}\/FederationInstance`/);
  });
});
