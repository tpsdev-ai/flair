import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyKeysDir, applyKeyPrune, makeReadInstanceIds } from "../../src/commands/keys.ts";
import { serializeSeedOwner, SEED_OWNER_SUFFIX, seedOwnerPath, readSeedOwner, readSeedOwnerAt, recordSeedOwner } from "../../src/keystore.ts";
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


describe("keys prune — two instances sharing a home (flair#2200)", () => {
  test("pruning either instance moves nothing of the other's", async () => {
    const dir = tempDir("flair-seed-owner-");
    writeNodeSeed(dir, LIVE);
    writeOwner(dir, LIVE, "/stores/live");
    writeNodeSeed(dir, OTHER);
    writeOwner(dir, OTHER, "/stores/other");

    const liveResult = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    expect(classes(liveResult.entries)).toEqual({ [LIVE]: "keep", [OTHER]: "unidentified" });
    expect(liveResult.entries.find((e) => e.agentId === OTHER)?.reason).toContain("not the targeted instance");
    expect(applyKeyPrune(dir, liveResult.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(dir, `${LIVE}.key`))).toBe(true);
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
    expect(existsSync(join(dir, ".pruned"))).toBe(false);

    // Now target the OTHER instance: symmetric, and still nothing moves.
    const otherResult = await classifyKeysDir(dir, BASE_URL, reader([OTHER], "/stores/other"));
    expect(classes(otherResult.entries)).toEqual({ [OTHER]: "keep", [LIVE]: "unidentified" });
    expect(otherResult.entries.find((e) => e.agentId === LIVE)?.reason).toContain("not the targeted instance");
    expect(applyKeyPrune(dir, otherResult.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(dir, `${LIVE}.key`))).toBe(true);
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
    expect(existsSync(join(dir, ".pruned"))).toBe(false);
  });

  test("a planted sidecar naming another live seed never authorizes a move", async () => {
    const dir = tempDir("flair-seed-owner-planted-");
    writeNodeSeed(dir, OTHER);
    writeOwner(dir, OTHER, "/stores/live");
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    expect(result.entries.find((e) => e.agentId === OTHER)?.class).toBe("unidentified");
    expect(result.entries.find((e) => e.agentId === OTHER)?.reason).toContain("unauthenticated");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
    expect(existsSync(ownerPath(dir, OTHER))).toBe(true);
    expect(existsSync(join(dir, ".pruned"))).toBe(false);
  });

  test("a seed with no owner record is listed and never moved", async () => {
    const dir = tempDir("flair-seed-owner-none-");
    writeNodeSeed(dir, OTHER);
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    const entry = result.entries.find((e) => e.agentId === OTHER);
    expect(entry?.class).toBe("unidentified");
    expect(entry?.reason).toContain("no owner record");
    expect(entry?.reason).toContain("ownership cannot be proven");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
    expect(existsSync(join(dir, ".pruned"))).toBe(false);
  });

  test("a malformed owner record is listed and never moved", async () => {
    const dir = tempDir("flair-seed-owner-malformed-");
    writeNodeSeed(dir, OTHER);
    writeFileSync(ownerPath(dir, OTHER), "{ this is not json\n");
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    const entry = result.entries.find((e) => e.agentId === OTHER);
    expect(entry?.class).toBe("unidentified");
    expect(entry?.reason).toContain("malformed");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
  });

  test("a malformed owner record missing its fields is listed and never moved", async () => {
    const dir = tempDir("flair-seed-owner-shape-");
    writeNodeSeed(dir, OTHER);
    writeFileSync(ownerPath(dir, OTHER), JSON.stringify({ v: 1, instanceId: OTHER }));
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    const entry = result.entries.find((e) => e.agentId === OTHER);
    expect(entry?.class).toBe("unidentified");
    expect(entry?.reason).toContain("malformed");
    expect(entry?.reason).toContain("data directory");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
  });

  test("an unreadable owner record is listed and never moved", async () => {
    const dir = tempDir("flair-seed-owner-unreadable-");
    writeNodeSeed(dir, OTHER);
    mkdirSync(ownerPath(dir, OTHER)); // a directory: reading it as a file fails
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    const entry = result.entries.find((e) => e.agentId === OTHER);
    expect(entry?.class).toBe("unidentified");
    expect(entry?.reason).toContain("could not be read");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
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
    expect(entry?.class).toBe("unidentified");
    expect(entry?.reason).toContain("does not belong to this seed");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
  });

  test("a node-shaped file is never moved on a bare stale/invalid classification", () => {
    const dir = tempDir("flair-seed-owner-defense-");
    writeNodeSeed(dir, ORPHAN);
    for (const classification of ["stale", "invalid", "orphan-seed"] as const) {
      expect(applyKeyPrune(dir, [{ name: `${ORPHAN}.key`, class: classification, reason: "fixture" }], "2026-10-03")).toEqual({ moved: [], skipped: [] });
      expect(existsSync(join(dir, `${ORPHAN}.key`))).toBe(true);
    }
    expect(existsSync(join(dir, ".pruned"))).toBe(false);
  });

  test("a registered Agent key with a missing .pub is never treated as an instance seed", async () => {
    const dir = tempDir("flair-seed-owner-agent-");
    writeNodeSeed(dir, ORPHAN);
    writeOwner(dir, ORPHAN, "/stores/live");
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live", [ORPHAN]));
    const entry = result.entries.find((e) => e.agentId === ORPHAN);
    expect(entry?.class).toBe("unidentified");
    expect(entry?.reason).toContain("Agent");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(dir, `${ORPHAN}.key`))).toBe(true);
  });

  test("a node-shaped Agent key missing .pub on another instance stays unidentified", async () => {
    const dir = tempDir("flair-seed-owner-foreign-agent-");
    writeFileSync(join(dir, `${OTHER}.key`), Buffer.alloc(32, 7));
    writeOwner(dir, OTHER, "/stores/live");
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live", []));
    expect(result.entries.find((e) => e.agentId === OTHER)?.class).toBe("unidentified");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(dir, `${OTHER}.key`))).toBe(true);
  });

  test("no owner record can be proven when the targeted data directory is not established", async () => {
    const dir = tempDir("flair-seed-owner-nodir-");
    writeNodeSeed(dir, ORPHAN);
    writeOwner(dir, ORPHAN, "/stores/live");
    // A read that yields the Instance rows but no data directory (no --data-dir).
    const result = await classifyKeysDir(dir, BASE_URL, async () => ({ state: "read" as const, ids: [LIVE], agentIds: [] }));
    const entry = result.entries.find((e) => e.agentId === ORPHAN);
    expect(entry?.class).toBe("unidentified");
    expect(entry?.reason).toContain("could not be established");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
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
    const fd = openSync(seedOwnerPath(id), "r");
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(readFileSync(fd, "utf-8")).toContain("/stores/xyz");
    } finally {
      closeSync(fd);
    }
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
    expect(existsSync(seedOwnerPath(id).slice(0, -SEED_OWNER_SUFFIX.length))).toBe(true);
    expect(readSeedOwner(id)).toEqual({ state: "ok", instanceId: id, dataDir: "/stores/minted" });
  });
});

describe("makeReadInstanceIds — unverifiable directory binding", () => {
  test("another instance directory recording the same port refuses by name and moves nothing", async () => {
    const dir = tempDir("flair-seed-binding-");
    const live = join(dir, "live");
    const other = join(dir, "other");
    for (const dataDir of [live, other]) {
      mkdirSync(dataDir);
      writeFileSync(join(dataDir, "harperdb-config.yaml"), "http:\n  port: 19926\n");
    }
    const keys = join(dir, "keys");
    mkdirSync(keys);
    writeNodeSeed(keys, OTHER);
    writeOwner(keys, OTHER, other);
    writeFileSync(join(keys, "agent-stale.key"), "fixture");
    let probes = 0;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return Response.json({ federation: { instance: { id: LIVE } } });
    }) as unknown as typeof fetch;
    const read = makeReadInstanceIds({
      baseUrl: BASE_URL, dataDir: other,
      resolveHttpPort: () => 19926, resolveOpsPort: () => 19925,
      probe: async () => { probes++; return { state: "read", ids: [LIVE], agentIds: [] }; },
    });
    const result = await classifyKeysDir(keys, BASE_URL, read);
    expect(result.aborted).toBe(true);
    expect(result.abortReason).toContain(other);
    expect(result.abortReason).toContain("identity cannot be verified");
    expect(result.entries).toEqual([]);
    expect(probes).toBe(0);
    expect(fetches).toBe(0);
    expect(applyKeyPrune(keys, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(keys, `${OTHER}.key`))).toBe(true);
    expect(existsSync(join(keys, "agent-stale.key"))).toBe(true);
  });
});

describe("keys prune — sidecar move ordering", () => {
  test("sidecar moves before the agent key and both reach the archive", () => {
    const dir = tempDir("flair-seed-owner-order-");
    const name = "agent-stale.key";
    writeFileSync(join(dir, name), "fixture");
    writeFileSync(join(dir, `${name}${SEED_OWNER_SUFFIX}`), "metadata");
    const order: string[] = [];
    const { moved } = applyKeyPrune(dir, [{ name, class: "stale", reason: "fixture" }], "2026-10-03", (from, to) => {
      order.push(String(from));
      expect(existsSync(join(dir, name))).toBe(true);
      renameSync(from, to);
    });
    expect(order).toEqual([join(dir, `${name}${SEED_OWNER_SUFFIX}`), join(dir, name)]);
    expect(moved).toHaveLength(1);
    expect(existsSync(join(dir, name))).toBe(false);
    expect(existsSync(join(dir, `${name}${SEED_OWNER_SUFFIX}`))).toBe(false);
    expect(existsSync(join(dir, ".pruned", "2026-10-03", name))).toBe(true);
    expect(existsSync(join(dir, ".pruned", "2026-10-03", `${name}${SEED_OWNER_SUFFIX}`))).toBe(true);
  });

  test("failure of the second move keeps the key active and restores the sidecar", () => {
    const dir = tempDir("flair-seed-owner-rollback-");
    const name = "agent-stale.key";
    writeFileSync(join(dir, name), "fixture");
    writeFileSync(join(dir, `${name}${SEED_OWNER_SUFFIX}`), "metadata");
    let moves = 0;
    expect(() => applyKeyPrune(dir, [{ name, class: "stale", reason: "fixture" }], "2026-10-03", (from, to) => {
      moves++;
      expect(existsSync(join(dir, name))).toBe(true);
      if (moves === 1) expect(String(from)).toEndWith(SEED_OWNER_SUFFIX);
      if (moves === 2) throw new Error("injected second move failure");
      renameSync(from, to);
    })).toThrow("injected second move failure");
    expect(moves).toBe(3);
    expect(existsSync(join(dir, name))).toBe(true);
    expect(existsSync(join(dir, `${name}${SEED_OWNER_SUFFIX}`))).toBe(true);
    expect(existsSync(join(dir, ".pruned", "2026-10-03", name))).toBe(false);
    expect(existsSync(join(dir, ".pruned", "2026-10-03", `${name}${SEED_OWNER_SUFFIX}`))).toBe(false);
  });

  test("sidecar-write failure leaves the stored file report-only", async () => {
    const id = "flair_abcd0123";
    const owner = seedOwnerPath(id);
    mkdirSync(owner, { recursive: true });
    const logs: string[] = [];
    const realError = console.error;
    console.error = (message) => { logs.push(String(message)); };
    try {
      await storeInstanceSeed(id, new Uint8Array(32).fill(7), "/stores/live");
    } finally {
      console.error = realError;
    }
    const message = logs.join("\n");
    expect(message).toContain("EISDIR");
    expect(message).toContain("inspect and clear any conflicting sidecar path");
    expect(message).toContain("writable by the Harper process");
    expect(message).toContain("report-only");
    const dir = owner.slice(0, owner.lastIndexOf("/"));
    const result = await classifyKeysDir(dir, BASE_URL, reader([LIVE], "/stores/live"));
    expect(result.entries.find((e) => e.agentId === id)?.class).toBe("unidentified");
    expect(applyKeyPrune(dir, result.entries, "2026-10-03")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(owner.slice(0, -SEED_OWNER_SUFFIX.length))).toBe(true);
  });
});

describe("keys prune — sidecar file type checks (flair#2286)", () => {
  const NAME = "agent-stale.key";

  /** A temp keys dir holding one stale key and a sidecar path of `kind`. */
  function sidecarFixture(
    kind: "directory" | "symlink" | "dangling symlink" | "FIFO" | "regular",
  ): { dir: string; sidecar: string } {
    const dir = tempDir("flair-sidecar-kind-");
    writeFileSync(join(dir, NAME), "fixture");
    const sidecar = join(dir, `${NAME}${SEED_OWNER_SUFFIX}`);
    if (kind === "directory") mkdirSync(sidecar);
    else if (kind === "symlink") {
      writeFileSync(join(dir, "target.json"), "{}");
      symlinkSync(join(dir, "target.json"), sidecar);
    } else if (kind === "dangling symlink") symlinkSync(join(dir, "missing.json"), sidecar);
    else if (kind === "FIFO") execFileSync("mkfifo", [sidecar]);
    else writeFileSync(sidecar, "metadata");
    return { dir, sidecar };
  }

  for (const [kind, typeName] of [
    ["directory", "directory"],
    ["symlink", "symbolic link"],
    ["dangling symlink", "symbolic link"],
    ["FIFO", "FIFO"],
  ] as const) {
    test(`a ${kind} at the sidecar path leaves the key and the path in place, naming both`, () => {
      const { dir, sidecar } = sidecarFixture(kind);
      const outcome = applyKeyPrune(dir, [{ name: NAME, class: "stale", reason: "fixture" }], "2026-10-03");

      expect(outcome.moved).toEqual([]);
      expect(outcome.skipped).toHaveLength(1);
      expect(outcome.skipped[0].name).toBe(NAME);
      expect(outcome.skipped[0].ownerPath).toBe(sidecar);
      expect(outcome.skipped[0].reason).toContain(sidecar);
      expect(outcome.skipped[0].reason).toContain(typeName);

      // Nothing moved: the key is still there and no archive was created.
      expect(existsSync(join(dir, NAME))).toBe(true);
      expect(existsSync(join(dir, ".pruned"))).toBe(false);
      // The sidecar path still holds a non-regular file (read nothing — a FIFO
      // read would block).
      expect(lstatSync(sidecar).isFile()).toBe(false);
    });
  }

  for (const replacement of ["directory", "symlink"] as const) {
    test(`a ${replacement} moved from a changed sidecar path is restored before the key moves`, () => {
      const { dir, sidecar } = sidecarFixture("regular");
      let first = true;
      const outcome = applyKeyPrune(dir, [{ name: NAME, class: "stale", reason: "fixture" }], "2026-10-03", (from, to) => {
        if (first) {
          first = false;
          renameSync(sidecar, join(dir, "previous-owner.json"));
          if (replacement === "directory") mkdirSync(sidecar);
          else symlinkSync(join(dir, "missing.json"), sidecar);
        }
        renameSync(from, to);
      });
      expect(outcome.moved).toEqual([]);
      expect(outcome.skipped).toHaveLength(1);
      expect(outcome.skipped[0].reason).toContain(replacement === "directory" ? "directory" : "symbolic link");
      expect(existsSync(join(dir, NAME))).toBe(true);
      expect(lstatSync(sidecar).isFile()).toBe(false);
      expect(existsSync(join(dir, ".pruned", "2026-10-03", NAME))).toBe(false);
      expect(() => lstatSync(join(dir, ".pruned", "2026-10-03", `${NAME}${SEED_OWNER_SUFFIX}`))).toThrow();
    });
  }

  for (const kind of ["directory", "regular"] as const) {
    test(`a ${kind} sidecar appearing before its move is checked at the destination`, () => {
      const dir = tempDir("flair-sidecar-appearing-");
      const sidecar = join(dir, `${NAME}${SEED_OWNER_SUFFIX}`);
      writeFileSync(join(dir, NAME), "fixture");
      let first = true;
      const outcome = applyKeyPrune(dir, [{ name: NAME, class: "stale", reason: "fixture" }], "2026-10-03", (from, to) => {
        if (first) {
          first = false;
          if (kind === "directory") mkdirSync(sidecar);
          else writeFileSync(sidecar, "metadata");
        }
        renameSync(from, to);
      });
      if (kind === "directory") {
        expect(outcome.moved).toEqual([]);
        expect(outcome.skipped).toHaveLength(1);
        expect(existsSync(join(dir, NAME))).toBe(true);
        expect(lstatSync(sidecar).isDirectory()).toBe(true);
      } else {
        expect(outcome.skipped).toEqual([]);
        expect(outcome.moved).toHaveLength(1);
        expect(readFileSync(join(dir, ".pruned", "2026-10-03", `${NAME}${SEED_OWNER_SUFFIX}`), "utf8")).toBe("metadata");
        expect(existsSync(sidecar)).toBe(false);
      }
    });

    test(`a ${kind} sidecar appearing after a missing-sidecar move leaves the key active`, () => {
      const dir = tempDir("flair-sidecar-recheck-");
      const sidecar = join(dir, `${NAME}${SEED_OWNER_SUFFIX}`);
      writeFileSync(join(dir, NAME), "fixture");
      const outcome = applyKeyPrune(dir, [{ name: NAME, class: "stale", reason: "fixture" }], "2026-10-03", (from, to) => {
        if (String(from) === sidecar) {
          try {
            renameSync(from, to);
          } catch (err) {
            if (kind === "directory") mkdirSync(sidecar);
            else writeFileSync(sidecar, "metadata");
            throw err;
          }
        } else {
          if (kind === "directory") mkdirSync(sidecar);
          else writeFileSync(sidecar, "metadata");
          renameSync(from, to);
        }
      });
      expect(outcome.moved).toEqual([]);
      expect(outcome.skipped).toHaveLength(1);
      expect(existsSync(join(dir, NAME))).toBe(true);
      expect(existsSync(sidecar)).toBe(true);
      expect(existsSync(join(dir, ".pruned", "2026-10-03", NAME))).toBe(false);
    });
  }

  test("a regular sidecar still moves with its key", () => {
    const { dir } = sidecarFixture("regular");
    const outcome = applyKeyPrune(dir, [{ name: NAME, class: "stale", reason: "fixture" }], "2026-10-03");

    expect(outcome.skipped).toEqual([]);
    expect(outcome.moved).toHaveLength(1);
    expect(outcome.moved[0].movedTo).toBe(join(dir, ".pruned", "2026-10-03", NAME));
    expect(existsSync(join(dir, NAME))).toBe(false);
    expect(existsSync(join(dir, ".pruned", "2026-10-03", NAME))).toBe(true);
    expect(existsSync(join(dir, ".pruned", "2026-10-03", `${NAME}${SEED_OWNER_SUFFIX}`))).toBe(true);
  });

  test("a key with no sidecar at all still moves", () => {
    const dir = tempDir("flair-sidecar-none-");
    writeFileSync(join(dir, NAME), "fixture");
    const outcome = applyKeyPrune(dir, [{ name: NAME, class: "stale", reason: "fixture" }], "2026-10-03");
    expect(outcome.skipped).toEqual([]);
    expect(outcome.moved).toHaveLength(1);
    expect(existsSync(join(dir, ".pruned", "2026-10-03", NAME))).toBe(true);
  });
});

// ─── CLI wiring ───────────────────────────────────────────────────────────────

describe("`flair keys prune` omits --data-dir (flair#2200)", () => {
  test("does not register --data-dir", () => {
    const prune = program.commands.find((c) => c.name() === "keys")?.commands.find((c) => c.name() === "prune");
    expect(prune).toBeDefined();
    expect(prune!.options.some((o: { flags: string }) => o.flags.includes("--data-dir"))).toBe(false);
  });
});
