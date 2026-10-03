/**
 * keys-prune-seed-owner.test.ts — `flair keys prune` removes an instance seed
 * ONLY with proof of which instance owns it (flair#2200).
 *
 * A keystore directory is shared by every instance running under the same home,
 * while each instance keeps its own `flair.Instance` table. So one instance's
 * table cannot show that a seed is unused, and #2198 shipped the report-only
 * half: `flair keys prune --apply` never moved a node-shaped seed. #2200 adds
 * the proof: the mint writes an ownership sidecar (`<seed>.key.owner.json`)
 * naming the instance id and data directory, and prune removes a seed only when
 * the sidecar names the TARGETED instance (by data directory, the instance
 * identity) AND the targeted instance's tables do not reference the seed.
 *
 * Everything here runs against temp key dirs and stubbed Instance reads — no
 * network, no real `~/.flair`, no key material read or printed beyond file
 * names.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyKeysDir, applyKeyPrune, makeReadInstanceIds } from "../../src/commands/keys.ts";
import { keystore, serializeSeedOwner, SEED_OWNER_SUFFIX, seedOwnerPath, readSeedOwner, readSeedOwnerAt, recordSeedOwner } from "../../src/keystore.ts";
import { storeInstanceSeed } from "../../resources/instance-create-lock.js";
import { program } from "../../src/cli.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const BASE_URL = "http://127.0.0.1:19926";
const LIVE = "flair_2222bbbb";
const OTHER = "flair_1111aaaa";
const ORPHAN = "flair_deadbeef";

function writeNodeSeed(dir: string, id: string): void {
  writeFileSync(join(dir, `${id}.key`), Buffer.alloc(60, 42));
}

function ownerPath(dir: string, id: string): string {
  return join(dir, `${id}.key${SEED_OWNER_SUFFIX}`);
}

/** Write a well-formed owner sidecar for `id`, recording `dataDir`. */
function writeOwner(dir: string, id: string, dataDir: string): void {
  writeFileSync(ownerPath(dir, id), serializeSeedOwner({ v: 1, instanceId: id, dataDir }));
}

/** A stubbed Instance/Agent read: the targeted instance's rows, its data directory and Agent ids. */
function reader(ids: string[], dataDir: string, agentIds: string[] = []) {
  return async () => ({ state: "read" as const, ids, dataDir, agentIds });
}

const classes = (entries: Array<{ agentId?: string; class: string }>) =>
  Object.fromEntries(entries.filter((e) => e.agentId).map((e) => [e.agentId, e.class]));

// ─── the ownership proof ─────────────────────────────────────────────────────

describe("keys prune — two instances sharing a home (flair#2200)", () => {
  test("pruning either instance moves nothing of the other's", async () => {
    const dir = tempDir("flair-seed-owner-");
    writeNodeSeed(dir, LIVE);
    writeOwner(dir, LIVE, "/stores/live");
    writeNodeSeed(dir, OTHER);
    writeOwner(dir, OTHER, "/stores/other");

    // Target the LIVE instance: its own row references its seed; OTHER's seed is
    // owned by another data directory.
    const liveResult = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    expect(classes(liveResult.entries)).toEqual({ [LIVE]: "keep", [OTHER]: "orphan-candidate" });
    expect(liveResult.entries.find((e) => e.agentId === OTHER)?.reason).toContain("not the targeted instance");
    expect(applyKeyPrune(dir, liveResult.entries, "2026-10-03")).toEqual([]);
    expect(existsSync(join(dir, `${LIVE}.key`))).toBe(true);
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
    expect(existsSync(join(dir, ".pruned"))).toBe(false);

    // Now target the OTHER instance: symmetric, and still nothing moves.
    const otherResult = await classifyKeysDir(dir, BASE_URL, reader([OTHER], "/stores/other"));
    expect(classes(otherResult.entries)).toEqual({ [OTHER]: "keep", [LIVE]: "orphan-candidate" });
    expect(otherResult.entries.find((e) => e.agentId === LIVE)?.reason).toContain("not the targeted instance");
    expect(applyKeyPrune(dir, otherResult.entries, "2026-10-03")).toEqual([]);
    expect(existsSync(join(dir, `${LIVE}.key`))).toBe(true);
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
    expect(existsSync(join(dir, ".pruned"))).toBe(false);
  });

  test("a seed owned by the targeted instance and unreferenced is removed", async () => {
    const dir = tempDir("flair-seed-owner-move-");
    writeNodeSeed(dir, ORPHAN);
    writeOwner(dir, ORPHAN, "/stores/live");

    // The targeted instance's table names LIVE, not ORPHAN, so ORPHAN is
    // unreferenced; its owner sidecar names the targeted instance's data dir.
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    const entry = result.entries.find((e) => e.agentId === ORPHAN);
    expect(entry?.class).toBe("orphan-seed");
    expect(entry?.reason).toContain("does not reference");

    const moved = applyKeyPrune(dir, result.entries, "2026-10-03");
    expect(moved.map((m) => m.name)).toEqual([`${ORPHAN}.key`]);
    expect(existsSync(join(dir, `${ORPHAN}.key`))).toBe(false);
    expect(existsSync(join(dir, ".pruned", "2026-10-03", `${ORPHAN}.key`))).toBe(true);
    // The owner sidecar moves with it — no sidecar is left beside a gone seed.
    expect(existsSync(ownerPath(dir, ORPHAN))).toBe(false);
    expect(existsSync(join(dir, ".pruned", "2026-10-03", `${ORPHAN}.key${SEED_OWNER_SUFFIX}`))).toBe(true);
  });

  test("a seed with no owner record is listed and never moved", async () => {
    const dir = tempDir("flair-seed-owner-none-");
    writeNodeSeed(dir, OTHER);
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    const entry = result.entries.find((e) => e.agentId === OTHER);
    expect(entry?.class).toBe("orphan-candidate");
    expect(entry?.reason).toContain("no owner record");
    expect(entry?.reason).toContain("ownership cannot be proven");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual([]);
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
    expect(existsSync(join(dir, ".pruned"))).toBe(false);
  });

  test("a malformed owner record is listed and never moved", async () => {
    const dir = tempDir("flair-seed-owner-malformed-");
    writeNodeSeed(dir, OTHER);
    writeFileSync(ownerPath(dir, OTHER), "{ this is not json\n");
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    const entry = result.entries.find((e) => e.agentId === OTHER);
    expect(entry?.class).toBe("orphan-candidate");
    expect(entry?.reason).toContain("malformed");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual([]);
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
  });

  test("a malformed owner record missing its fields is listed and never moved", async () => {
    const dir = tempDir("flair-seed-owner-shape-");
    writeNodeSeed(dir, OTHER);
    writeFileSync(ownerPath(dir, OTHER), JSON.stringify({ v: 1, instanceId: OTHER }));
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    const entry = result.entries.find((e) => e.agentId === OTHER);
    expect(entry?.class).toBe("orphan-candidate");
    expect(entry?.reason).toContain("malformed");
    expect(entry?.reason).toContain("data directory");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual([]);
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
  });

  test("an unreadable owner record is listed and never moved", async () => {
    const dir = tempDir("flair-seed-owner-unreadable-");
    writeNodeSeed(dir, OTHER);
    mkdirSync(ownerPath(dir, OTHER)); // a directory: reading it as a file fails
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    const entry = result.entries.find((e) => e.agentId === OTHER);
    expect(entry?.class).toBe("orphan-candidate");
    expect(entry?.reason).toContain("could not be read");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual([]);
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
  });

  test("an owner record that names a different seed is listed and never moved", async () => {
    const dir = tempDir("flair-seed-owner-mismatch-");
    writeNodeSeed(dir, OTHER);
    writeOwner(dir, OTHER, "/stores/live");
    // Rewrite the sidecar to name a different seed id.
    writeFileSync(ownerPath(dir, OTHER), serializeSeedOwner({ v: 1, instanceId: "flair_9999ffff", dataDir: "/stores/live" }));
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    const entry = result.entries.find((e) => e.agentId === OTHER);
    expect(entry?.class).toBe("orphan-candidate");
    expect(entry?.reason).toContain("does not belong to this seed");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual([]);
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
  });

  test("a node-shaped file is never moved on a bare stale/invalid classification", () => {
    const dir = tempDir("flair-seed-owner-defense-");
    writeNodeSeed(dir, ORPHAN);
    for (const classification of ["stale", "invalid"] as const) {
      expect(applyKeyPrune(dir, [{ name: `${ORPHAN}.key`, class: classification, reason: "fixture" }], "2026-10-03")).toEqual([]);
      expect(existsSync(join(dir, `${ORPHAN}.key`))).toBe(true);
    }
    expect(existsSync(join(dir, ".pruned"))).toBe(false);
  });

  test("a registered Agent key with a missing .pub is never treated as an instance seed", async () => {
    const dir = tempDir("flair-seed-owner-agent-");
    writeNodeSeed(dir, ORPHAN);
    // Even with an owner sidecar naming the targeted instance, an id the Agent
    // table registers is an agent signing key, not an instance seed.
    writeOwner(dir, ORPHAN, "/stores/live");
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live", [ORPHAN]));
    const entry = result.entries.find((e) => e.agentId === ORPHAN);
    expect(entry?.class).toBe("unidentified");
    expect(entry?.reason).toContain("Agent");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual([]);
    expect(existsSync(join(dir, `${ORPHAN}.key`))).toBe(true);
  });

  test("no owner record can be proven when the targeted data directory is not established", async () => {
    const dir = tempDir("flair-seed-owner-nodir-");
    writeNodeSeed(dir, ORPHAN);
    writeOwner(dir, ORPHAN, "/stores/live");
    // A read that yields the Instance rows but no data directory (no --data-dir).
    const result = await classifyKeysDir(dir, BASE_URL, async () => ({ state: "read" as const, ids: [LIVE], agentIds: [] }));
    const entry = result.entries.find((e) => e.agentId === ORPHAN);
    expect(entry?.class).toBe("orphan-candidate");
    expect(entry?.reason).toContain("could not be established");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual([]);
    expect(existsSync(join(dir, `${ORPHAN}.key`))).toBe(true);
  });
});

// ─── the owner sidecar itself ────────────────────────────────────────────────

describe("keystore seed-owner sidecar (flair#2200)", () => {
  test("recordSeedOwner writes an owner-only sidecar that readSeedOwner round-trips", () => {
    const id = `flair_${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}`;
    recordSeedOwner(id, "/stores/xyz");
    const read = readSeedOwner(id);
    expect(read).toEqual({ state: "ok", instanceId: id, dataDir: "/stores/xyz" });
    expect(statSync(seedOwnerPath(id)).mode & 0o777).toBe(0o600);
    expect(readFileSync(seedOwnerPath(id), "utf-8")).toContain("/stores/xyz");
  });

  test("readSeedOwnerAt reports absent, malformed and unreadable distinctly", () => {
    const dir = tempDir("flair-seed-owner-read-");
    const p = join(dir, "flair_00000000.key.owner.json");
    expect(readSeedOwnerAt(p).state).toBe("absent");
    writeFileSync(p, "not json");
    expect(readSeedOwnerAt(p).state).toBe("malformed");
    mkdirSync(join(dir, "flair_11111111.key.owner.json"));
    expect(readSeedOwnerAt(join(dir, "flair_11111111.key.owner.json")).state).toBe("unreadable");
  });

  test("the mint helper stores the seed and records its owner", async () => {
    const id = `flair_${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}`;
    const seed = new Uint8Array(32).fill(7);
    await storeInstanceSeed(id, seed, "/stores/minted");
    const stored = keystore.getPrivateKeySeed(id);
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!)).toEqual(Buffer.from(seed));
    expect(readSeedOwner(id)).toEqual({ state: "ok", instanceId: id, dataDir: "/stores/minted" });
  });
});

// ─── makeReadInstanceIds ties the data directory to the target ────────────────

describe("makeReadInstanceIds — the data directory is tied to the target (flair#2200)", () => {
  const IDS = [LIVE];
  function build(overrides: Partial<Parameters<typeof makeReadInstanceIds>[0]> = {}) {
    let probes = 0;
    const read = makeReadInstanceIds({
      baseUrl: "http://127.0.0.1:9926",
      port: undefined,
      resolveHttpPort: () => 9926,
      resolveOpsPort: () => 9925,
      resolveAdminPass: () => "fixture-password",
      probe: async () => { probes++; return { state: "read" as const, ids: IDS, agentIds: [] }; },
      ...overrides,
    });
    return { read, probes: () => probes };
  }

  test("a data directory recording the target's port lets the read proceed and is returned", async () => {
    globalThis.fetch = (async () => Response.json({ federation: { instance: { id: LIVE } } })) as unknown as typeof fetch;
    const b = build({ dataDir: "/stores/live", readPortFromHarperConfig: () => 9926 });
    const res = await b.read();
    expect(res.state).toBe("read");
    if (res.state === "read") expect(res.dataDir).toBe("/stores/live");
    expect(b.probes()).toBe(1);
  });

  test("a data directory recording a different port reads nothing", async () => {
    const b = build({ dataDir: "/stores/other", readPortFromHarperConfig: () => 19926 });
    const res = await b.read();
    expect(res.state).toBe("unreadable");
    if (res.state === "unreadable") expect(res.reason).toContain("not the targeted");
    expect(b.probes()).toBe(0);
  });

  test("a data directory that records no port reads nothing", async () => {
    const b = build({ dataDir: "/stores/live", readPortFromHarperConfig: () => null });
    const res = await b.read();
    expect(res.state).toBe("unreadable");
    if (res.state === "unreadable") expect(res.reason).toContain("records no instance port");
    expect(b.probes()).toBe(0);
  });

  test("a throwing port read reads nothing", async () => {
    const b = build({ dataDir: "/stores/live", readPortFromHarperConfig: () => { throw new Error("EACCES"); } });
    const res = await b.read();
    expect(res.state).toBe("unreadable");
    expect(b.probes()).toBe(0);
  });
});

// ─── CLI wiring ───────────────────────────────────────────────────────────────

describe("`flair keys prune` exposes --data-dir (flair#2200)", () => {
  test("registers --data-dir", () => {
    const prune = program.commands.find((c) => c.name() === "keys")?.commands.find((c) => c.name() === "prune");
    expect(prune).toBeDefined();
    expect(prune!.options.some((o: { flags: string }) => o.flags.includes("--data-dir"))).toBe(true);
  });
});
