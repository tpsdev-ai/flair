/**
 * federation-pair-identity.test.ts — flair#822
 *
 * Chip: fail-closed on the spoke. Pair already returns
 * `instance.{id,publicKey}` when the hub has a FederationInstance row
 * (flair#213). An empty spoke hub-Peer key means that row was missing
 * (#839). Never store `""`. A spoke Peer write does not provision the
 * hub row.
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

describe("resolveHubPeerIdentity — ERROR or fetch, never \"\"", () => {
  it("uses the pair response when instance.publicKey is present", async () => {
    const resolved = await resolveHubPeerIdentity(
      { instance: { id: HUB_ID, publicKey: HUB_KEY } },
      { fetchInstance: async () => { throw new Error("must not fetch"); } },
    );
    expect(resolved).toEqual({
      ok: true,
      source: "pair",
      peer: { id: HUB_ID, publicKey: HUB_KEY },
    });
  });

  it("may GET /FederationInstance for an existing hub identity when pair omitted the key", async () => {
    const resolved = await resolveHubPeerIdentity(
      { paired: true, instance: null },
      { fetchInstance: async () => ({ id: HUB_ID, publicKey: HUB_KEY, role: "hub" }) },
    );
    expect(resolved).toEqual({
      ok: true,
      source: "federation_instance",
      peer: { id: HUB_ID, publicKey: HUB_KEY },
    });
  });

  it("errors when pair and /FederationInstance both lack publicKey — never fill \"\"", async () => {
    const resolved = await resolveHubPeerIdentity(
      { instance: { id: "hub", publicKey: "" } },
      { fetchInstance: async () => ({ id: HUB_ID, publicKey: "" }) },
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toBe(EMPTY_HUB_PEER_KEY_ERROR);
    expect(resolved.error).toContain("flair#839");
    expect(resolved.error).toContain("does not create one");
  });

  it("errors when the fallback fetch throws or returns nothing", async () => {
    const thrown = await resolveHubPeerIdentity(
      { instance: null },
      { fetchInstance: async () => { throw new Error("403"); } },
    );
    expect(thrown.ok).toBe(false);
    if (thrown.ok) return;
    expect(thrown.error).toBe(EMPTY_HUB_PEER_KEY_ERROR);

    const missing = await resolveHubPeerIdentity({ instance: null });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error).toBe(EMPTY_HUB_PEER_KEY_ERROR);
  });
});

describe("wiring — spoke fail-closed; pair still returns instance when the row exists", () => {
  const root = join(import.meta.dir, "../..");

  it("FederationPair.post still returns instance.{id,publicKey} from the Instance row (flair#213)", () => {
    const src = readFileSync(join(root, "resources/Federation.ts"), "utf8");
    expect(src).toContain("id: ourInstance.id");
    expect(src).toContain("publicKey: ourInstance.publicKey");
    expect(src).toMatch(/instance:\s*ourInstance\s*\?/);
    expect(src).not.toContain("HUB_IDENTITY_INCOMPLETE");
    expect(src).not.toContain("pairResponseInstance");
  });

  it("spoke pair writes resolvedHub.peer.publicKey and never ?? \"\"", () => {
    const src = readFileSync(join(root, "src/cli.ts"), "utf8");
    expect(src).toContain("resolveHubPeerIdentity");
    expect(src).toContain("resolvedHub.peer.publicKey");
    expect(src).toContain("resolvedHub.peer.id");
    expect(src).not.toMatch(/publicKey:\s*result\.instance\?\.publicKey\s*\?\?\s*""/);
  });
});
