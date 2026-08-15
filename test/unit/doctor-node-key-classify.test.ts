/**
 * doctor-node-key-classify.test.ts — flair#1193.
 *
 * `~/.flair/keys/` is a namespace shared by two writers: agent Ed25519 signing
 * keys (32-byte raw seed at `<name>.key`, ALWAYS with a sibling `<name>.pub`)
 * and node-scoped federation keys (`flair_<hex8>.key`, an AES-256-GCM keystore
 * blob written by FileKeyStore during Fabric provisioning, with NO `.pub`).
 * Nothing used to tell them apart, so `flair doctor` tried to Ed25519-parse the
 * node blob (a "DECODER routines::unsupported" warning that reads as agent-auth
 * breakage) and `doctor --fix` could infer the node id as the sole "agent" and
 * wire it as a connector identity — a phantom, unregistered node whose key
 * cannot sign, breaking every read/write.
 *
 * These tests exercise the classifier and the two decisions it feeds against
 * REAL key files on disk in a temp dir (no Harper needed). The classifier is
 * structural — node id shape AND no sibling `.pub` — so it never depends on the
 * parse-failure of the thing it is classifying.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  isNodeKeyId,
  partitionKeyIds,
  inferSoleAgentId,
  resolveFixAgentId,
} from "../../src/doctor-client.ts";

const NODE_ID = "flair_1d786ba8";

let keysDir: string;

/** Write a node-scoped federation key: `flair_<hex8>.key`, ~60-byte blob, no `.pub`. */
function writeNodeKey(dir: string, id: string): void {
  writeFileSync(join(dir, `${id}.key`), cryptoRandomBytes(60)); // AES-256-GCM-shaped blob
}

/** Write an agent signing key: 32-byte seed `<name>.key` + a sibling `<name>.pub`. */
function writeAgentKey(dir: string, name: string): void {
  writeFileSync(join(dir, `${name}.key`), cryptoRandomBytes(32)); // raw Ed25519 seed
  writeFileSync(join(dir, `${name}.pub`), cryptoRandomBytes(32)); // Ed25519 public key
}

beforeEach(() => {
  keysDir = mkdtempSync(join(tmpdir(), "flair-1193-keys-"));
});

afterEach(() => {
  rmSync(keysDir, { recursive: true, force: true });
});

describe("isNodeKeyId", () => {
  test("a flair_<hex8> id with no sibling .pub is a node key", () => {
    writeNodeKey(keysDir, NODE_ID);
    expect(isNodeKeyId(NODE_ID, keysDir)).toBe(true);
  });

  test("a normal agent id (has a .pub) is NOT a node key", () => {
    writeAgentKey(keysDir, "local");
    expect(isNodeKeyId("local", keysDir)).toBe(false);
  });

  test("an id shaped like a node id but WITH a .pub is an agent, not a node key", () => {
    // Structural guard: shape alone is not enough — the .pub sibling means a
    // real keypair was written for it, so it is an agent even if oddly named.
    writeAgentKey(keysDir, "flair_deadbeef");
    expect(isNodeKeyId("flair_deadbeef", keysDir)).toBe(false);
  });

  test("wrong shape (not flair_<8 hex>) is never a node key", () => {
    // No .pub for any of these, so only the shape rule keeps them agents.
    expect(isNodeKeyId("local", keysDir)).toBe(false);
    expect(isNodeKeyId("flair_1d786ba", keysDir)).toBe(false); // 7 hex
    expect(isNodeKeyId("flair_1d786ba8a", keysDir)).toBe(false); // 9 hex
    expect(isNodeKeyId("flair_ZZZZZZZZ", keysDir)).toBe(false); // non-hex
    expect(isNodeKeyId("flair-1d786ba8", keysDir)).toBe(false); // wrong separator
  });
});

describe("partitionKeyIds — doctor enumeration classification", () => {
  test("splits the node key from the agent key (node never reaches the Ed25519/registration path)", () => {
    writeNodeKey(keysDir, NODE_ID);
    writeAgentKey(keysDir, "local");
    const { agentKeyIds, nodeKeyIds } = partitionKeyIds([NODE_ID, "local"], keysDir);
    // `local` is enumerated as an agent → it is the only id doctor will feed to
    // planAgentIterations → checkAgentRegistered → buildEd25519Auth. The node
    // id lands in nodeKeyIds, so the DECODER-warning path is never taken for it.
    expect(agentKeyIds).toEqual(["local"]);
    expect(nodeKeyIds).toEqual([NODE_ID]);
  });

  test("a node-only host yields zero agent keys", () => {
    writeNodeKey(keysDir, NODE_ID);
    const { agentKeyIds, nodeKeyIds } = partitionKeyIds([NODE_ID], keysDir);
    expect(agentKeyIds).toEqual([]);
    expect(nodeKeyIds).toEqual([NODE_ID]);
  });
});

describe("inferSoleAgentId over the partitioned (node-free) pool", () => {
  test("both present → returns the agent id, never the node id", () => {
    writeNodeKey(keysDir, NODE_ID);
    writeAgentKey(keysDir, "local");
    const { agentKeyIds } = partitionKeyIds([NODE_ID, "local"], keysDir);
    expect(inferSoleAgentId(agentKeyIds)).toBe("local");
  });

  test("node key only → returns undefined (NOT the node id)", () => {
    writeNodeKey(keysDir, NODE_ID);
    const { agentKeyIds } = partitionKeyIds([NODE_ID], keysDir);
    expect(inferSoleAgentId(agentKeyIds)).toBeUndefined();
  });
});

describe("resolveFixAgentId — doctor --fix connector identity (never a node id)", () => {
  test("both present → wires the agent", () => {
    writeNodeKey(keysDir, NODE_ID);
    writeAgentKey(keysDir, "local");
    const { agentKeyIds } = partitionKeyIds([NODE_ID, "local"], keysDir);
    expect(resolveFixAgentId({ keyAgentIds: agentKeyIds, keysDir })).toBe("local");
  });

  test("node-only host → refuses (undefined) rather than wiring the node id", () => {
    writeNodeKey(keysDir, NODE_ID);
    const { agentKeyIds } = partitionKeyIds([NODE_ID], keysDir);
    // This is the exact condition that prevents `doctor --fix` from writing
    // FLAIR_AGENT_ID=flair_... : a falsy id makes the caller take the refusal
    // branch instead of the wire branch.
    expect(resolveFixAgentId({ keyAgentIds: agentKeyIds, keysDir })).toBeUndefined();
  });

  test("a node id supplied via env/explicit source is still refused (guard covers all sources)", () => {
    writeNodeKey(keysDir, NODE_ID);
    // Even if FLAIR_AGENT_ID (or --agent) names the node id, it cannot sign, so
    // resolveFixAgentId drops it — a prior buggy run may have poisoned a wired
    // block with exactly this value.
    expect(resolveFixAgentId({ envAgentId: NODE_ID, keyAgentIds: [], keysDir })).toBeUndefined();
    expect(resolveFixAgentId({ optsAgent: NODE_ID, keyAgentIds: [], keysDir })).toBeUndefined();
    expect(resolveFixAgentId({ anyKnownAgentId: NODE_ID, keyAgentIds: [], keysDir })).toBeUndefined();
  });

  test("an explicit real agent is returned unchanged", () => {
    writeAgentKey(keysDir, "ci-bot");
    expect(resolveFixAgentId({ optsAgent: "ci-bot", keyAgentIds: [], keysDir })).toBe("ci-bot");
  });
});
