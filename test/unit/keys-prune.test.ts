/**
 * keys-prune.test.ts — Unit tests for `flair keys prune` (flair#734).
 *
 * Follow-up to #731's doctor agent-iteration, which made stale/unregistered
 * keys in ~/.flair/keys visible (each renders as a "not registered" gate
 * finding — see test/unit/doctor-agent-iteration.test.ts) but shipped no
 * command to act on it. `flair keys prune` classifies every file in the key
 * dir and, with --apply, MOVES (never deletes) anything prunable into
 * <keysDir>/.pruned/<date>/.
 *
 * classifyKeysDir/applyKeyPrune (src/cli.ts) are the exported, directly
 * testable orchestration — same pattern as checkAgentRegistered/
 * probeFlairReachable (test/unit/doctor-client-network.test.ts): mock
 * globalThis.fetch, write REAL Ed25519 keys via tweetnacl to a temp dir so
 * the signing path runs for real, only the network response is mocked.
 * classifyKeyFile/resolveCollisionSafeName/pruneDateStamp's own pure-decision
 * tests live in test/unit/doctor-client.test.ts.
 *
 * The two acceptance bullets that need a REAL process exit code (fresh/empty
 * dir exits 0; unreachable instance hard-aborts with a non-zero exit and
 * moves nothing) are covered here by spawning the CLI as a subprocess —
 * mirrors test/unit/cli-startup-errors.test.ts's technique, since an
 * in-process call can't observe process.exit().
 */

import { describe, it, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

import { classifyKeysDir, applyKeyPrune, program } from "../../src/cli.ts";
import { PRUNED_DIR_NAME } from "../../src/doctor-client.ts";
import { SEED_OWNER_SUFFIX } from "../../src/keystore.ts";
import { makeReadInstanceIds } from "../../src/commands/keys.ts";

const BASE_URL = "http://127.0.0.1:19926";
const CLI_SOURCE = join(__dirname, "..", "..", "src", "cli.ts");
const realFetch = globalThis.fetch;

// The Instance-row read the orphan check decides on (flair#1925). Every call in
// this file states what it established — a read that did not happen is
// `unreadable`, and NOTHING is then offered as orphan.
const noInstanceRead = async () => ({ state: "unreadable" as const, reason: "test: Instance rows were not read" });
const instanceRows = (ids: string[]) => async () => ({ state: "read" as const, ids, agentIds: [] });

let keysDir: string;

beforeEach(() => {
  keysDir = mkdtempSync(join(tmpdir(), "flair-keys-prune-"));
});

afterEach(() => {
  rmSync(keysDir, { recursive: true, force: true });
  globalThis.fetch = realFetch;
});

// ─── helpers ────────────────────────────────────────────────────────────────

/** Write a real, raw 32-byte Ed25519 seed at <keysDir>/<agentId>.key — the
 *  same format `flair agent add` writes (src/cli.ts, agent add action). */
function writeSeedKey(dir: string, agentId: string): void {
  const kp = nacl.sign.keyPair();
  writeFileSync(join(dir, `${agentId}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
}

/** Mock fetch for checkAgentRegistered's signed GET /Agent/:id — 200 for any
 *  agent id in `registeredIds`, the server's real "unknown_agent" 401 shape
 *  otherwise (flair#602 — that's the live not-registered signal, not 404). */
function mockRegistrationFetch(registeredIds: Set<string>): typeof fetch {
  return (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    const id = url.match(/\/Agent\/([^/]+)$/)?.[1];
    if (id && registeredIds.has(id)) {
      return new Response(JSON.stringify({ id }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "unknown_agent" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

// ─── classifyKeysDir ────────────────────────────────────────────────────────

describe("classifyKeysDir — fresh/empty key dir (acceptance: finds nothing)", () => {
  it("a keysDir that does not exist on disk → not aborted, zero entries, no network call", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const nonExistent = join(keysDir, "does-not-exist");
    const res = await classifyKeysDir(nonExistent, BASE_URL, noInstanceRead);
    expect(res.aborted).toBe(false);
    expect(res.entries).toEqual([]);
    expect(called).toBe(false);
  });

  it("an existing but empty keysDir → not aborted, zero entries, no network call", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const res = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    expect(res.aborted).toBe(false);
    expect(res.entries).toEqual([]);
    expect(called).toBe(false);
  });

  it("a keysDir containing only ignored files (README, no .key files) → zero candidates, no network call", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    writeFileSync(join(keysDir, "README.md"), "not a key\n");
    mkdirSync(join(keysDir, "some-subdir"));
    const res = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    expect(res.aborted).toBe(false);
    expect(res.entries.every((e) => e.class === "ignored")).toBe(true);
    expect(called).toBe(false);
  });

  it("skips its own .pruned archive directory rather than treating it as a candidate", async () => {
    mkdirSync(join(keysDir, PRUNED_DIR_NAME, "2026-01-01"), { recursive: true });
    const res = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].class).toBe("ignored");
    expect(res.entries[0].name).toBe(PRUNED_DIR_NAME);
  });
});

describe("classifyKeysDir — N unregistered + M registered", () => {
  it("dry-run classification lists exactly N stale and M keep, with reasons, without touching disk", async () => {
    writeSeedKey(keysDir, "agent-stale-1");
    writeSeedKey(keysDir, "agent-stale-2");
    writeSeedKey(keysDir, "agent-registered");
    globalThis.fetch = mockRegistrationFetch(new Set(["agent-registered"]));

    const res = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    expect(res.aborted).toBe(false);

    const stale = res.entries.filter((e) => e.class === "stale");
    const keep = res.entries.filter((e) => e.class === "keep");
    expect(stale.map((e) => e.agentId).sort()).toEqual(["agent-stale-1", "agent-stale-2"]);
    expect(keep.map((e) => e.agentId)).toEqual(["agent-registered"]);
    for (const e of stale) expect(e.reason.length).toBeGreaterThan(0);

    // Dry classification never moves anything.
    expect(existsSync(join(keysDir, "agent-stale-1.key"))).toBe(true);
    expect(existsSync(join(keysDir, "agent-stale-2.key"))).toBe(true);
    expect(existsSync(join(keysDir, "agent-registered.key"))).toBe(true);
    expect(existsSync(join(keysDir, PRUNED_DIR_NAME))).toBe(false);
  });
});

describe("classifyKeysDir — unidentifiable files classified distinctly from unregistered", () => {
  // flair#1026: an unparseable file is "unidentified", NOT "invalid", and is not
  // prunable. The keys dir is shared with AES-256-GCM keystore blobs, which do
  // not parse as seeds while being live federation keys.
  it("an unparseable .key file → class 'unidentified', and never triggers a network call", async () => {
    writeFileSync(join(keysDir, "garbage.key"), "not-a-real-ed25519-seed-at-all");
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;

    const res = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    expect(res.aborted).toBe(false);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].class).toBe("unidentified");
    expect(res.entries[0].name).toBe("garbage.key");
    expect(called).toBe(false);
  });

  it("unidentified and stale are reported as distinct classes side by side, and only stale is prunable", async () => {
    writeFileSync(join(keysDir, "garbage.key"), "not-a-real-ed25519-seed-at-all");
    writeSeedKey(keysDir, "agent-stale");
    globalThis.fetch = mockRegistrationFetch(new Set());

    const res = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    const byClass = Object.fromEntries(res.entries.map((e) => [e.name, e.class]));
    expect(byClass["garbage.key"]).toBe("unidentified");
    expect(byClass["agent-stale.key"]).toBe("stale");
  });

  it("a 60-byte keystore-shaped blob with the Instance rows NOT read → unidentified, no Agent-registration request", async () => {
    const blob = Buffer.from(Array.from({ length: 60 }, (_, i) => (i * 7 + 3) & 0xff));
    writeFileSync(join(keysDir, "flair_deadbeef.key"), blob);
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;

    const res = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    expect(res.aborted).toBe(false);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].class).toBe("unidentified");
    expect(res.entries[0].class).not.toBe("invalid");
    // The read did not happen, so the orphan class was NOT offered.
    expect(res.entries[0].class).not.toBe("orphan-candidate");
    expect(res.orphanRead?.state).toBe("unreadable");
    expect(called).toBe(false);
  });
});

describe("classifyKeysDir — orphan instance seeds (flair#1925)", () => {
  /** Write a keystore-shaped blob at a node-shaped id. */
  function writeNodeSeed(dir: string, id: string): void {
    writeFileSync(join(dir, `${id}.key`), Buffer.from(Array.from({ length: 60 }, (_, i) => (i * 7 + 3) & 0xff)));
  }

  it("a candidate and an id named by the checked Instance table are both kept", async () => {
    writeNodeSeed(keysDir, "flair_1111aaaa");
    writeNodeSeed(keysDir, "flair_2222bbbb");
    globalThis.fetch = mockRegistrationFetch(new Set());

    const res = await classifyKeysDir(keysDir, BASE_URL, instanceRows(["flair_2222bbbb"]));
    expect(res.aborted).toBe(false);

    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e.class]));
    expect(byName["flair_1111aaaa.key"]).toBe("unidentified");
    expect(byName["flair_2222bbbb.key"]).toBe("keep");

    const { moved } = applyKeyPrune(keysDir, res.entries, "2026-10-02");
    expect(moved).toEqual([]);
    expect(existsSync(join(keysDir, "flair_1111aaaa.key"))).toBe(true);
    expect(existsSync(join(keysDir, "flair_2222bbbb.key"))).toBe(true);
  });

  it("Instance rows NOT read → nothing is offered as orphan, and the result says why", async () => {
    writeNodeSeed(keysDir, "flair_1111aaaa");
    globalThis.fetch = mockRegistrationFetch(new Set());

    const res = await classifyKeysDir(keysDir, BASE_URL, async () => ({
      state: "unreadable" as const,
      reason: "no local admin credential",
    }));
    expect(res.entries.map((e) => e.class)).toEqual(["unidentified"]);
    expect(res.orphanRead).toEqual({ state: "unreadable", reason: "no local admin credential" });
    expect(applyKeyPrune(keysDir, res.entries, "2026-10-02")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(keysDir, "flair_1111aaaa.key"))).toBe(true);
  });

  it("the Instance rows are read once, and only when a node-shaped seed is present", async () => {
    writeSeedKey(keysDir, "agent-plain");
    globalThis.fetch = mockRegistrationFetch(new Set(["agent-plain"]));
    let reads = 0;
    const reader = async () => { reads++; return { state: "read" as const, ids: [], agentIds: [] }; };

    const noNode = await classifyKeysDir(keysDir, BASE_URL, reader);
    expect(reads).toBe(0);
    expect(noNode.orphanRead).toBeNull();

    writeNodeSeed(keysDir, "flair_1111aaaa");
    await classifyKeysDir(keysDir, BASE_URL, reader);
    expect(reads).toBe(1);
  });

  it("a node-shaped id WITH a sibling .pub stays an agent key (never an orphan)", async () => {
    const kp = nacl.sign.keyPair();
    writeFileSync(join(keysDir, "flair_deadbeef.key"), Buffer.from(kp.secretKey.slice(0, 32)));
    writeFileSync(join(keysDir, "flair_deadbeef.pub"), Buffer.from(kp.publicKey));
    globalThis.fetch = mockRegistrationFetch(new Set(["flair_deadbeef"]));

    const res = await classifyKeysDir(keysDir, BASE_URL, instanceRows([]));
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e.class]));
    expect(byName["flair_deadbeef.key"]).toBe("keep");
    expect(byName["flair_deadbeef.pub"]).toBe("ignored");
    expect(res.entries.find((e) => e.name === "flair_deadbeef.key")?.reason).toContain("registered");
    expect(res.orphanRead).toBeNull();
  });
});

describe("makeReadInstanceIds — the Instance rows are read only for the targeted local instance (flair#1925)", () => {
  function build(baseUrl: string, pass: string | null = "pw") {
    let probes = 0;
    const read = makeReadInstanceIds({
      baseUrl,
      resolveHttpPort: () => 9926,
      resolveOpsPort: () => 9925,
      resolveAdminPass: () => pass ?? undefined,
      probe: async () => { probes++; return { state: "read" as const, ids: ["flair_1111aaaa"], agentIds: [] }; },
    });
    return { read, probes: () => probes };
  }

  it("a local target on another port → unreadable, no read", async () => {
    const b = build("http://127.0.0.1:29926");
    const res = await b.read();
    expect(res.state).toBe("unreadable");
    expect(b.probes()).toBe(0);
  });

  it("a non-local target → unreadable, no read", async () => {
    const b = build("http://flair.example.com:9926");
    const res = await b.read();
    expect(res.state).toBe("unreadable");
    expect(b.probes()).toBe(0);
  });

  it("no local admin credential → unreadable, the ops read is never called", async () => {
    const b = build("http://127.0.0.1:9926", null);
    const res = await b.read();
    expect(res.state).toBe("unreadable");
    expect(b.probes()).toBe(0);
  });

  it("the targeted local instance with a credential → the rows are read", async () => {
    globalThis.fetch = (async () => Response.json({ federation: { instance: { id: "flair_1111aaaa" } } })) as typeof fetch;
    const b = build("http://127.0.0.1:9926");
    expect((await b.read()).state).toBe("read");
    expect(b.probes()).toBe(1);
  });
});

describe("classifyKeysDir — unreachable instance aborts the whole run", () => {
  it("a network failure on the registration check aborts before classifying anything, nothing moved", async () => {
    writeSeedKey(keysDir, "agent-a");
    writeSeedKey(keysDir, "agent-b");
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;

    const res = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    expect(res.aborted).toBe(true);
    expect(res.entries).toEqual([]);
    expect(res.abortReason).toBeDefined();
    expect(res.abortReason).toContain(BASE_URL);

    // Nothing was ever touched.
    expect(existsSync(join(keysDir, "agent-a.key"))).toBe(true);
    expect(existsSync(join(keysDir, "agent-b.key"))).toBe(true);
    expect(existsSync(join(keysDir, PRUNED_DIR_NAME))).toBe(false);
  });
});

// ─── applyKeyPrune ──────────────────────────────────────────────────────────

describe("applyKeyPrune — --apply moves prunable keys, leaves registered ones untouched", () => {
  it("moves exactly the stale entries into .pruned/<date>/; a registered key and an UNIDENTIFIABLE file are NEVER moved", async () => {
    writeSeedKey(keysDir, "agent-stale-1");
    writeSeedKey(keysDir, "agent-stale-2");
    writeSeedKey(keysDir, "agent-registered");
    writeFileSync(join(keysDir, "garbage.key"), "not-a-real-ed25519-seed-at-all");
    globalThis.fetch = mockRegistrationFetch(new Set(["agent-registered"]));

    const classified = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    expect(classified.aborted).toBe(false);

    const { moved } = applyKeyPrune(keysDir, classified.entries, "2026-07-18");
    expect(moved).toHaveLength(2);
    expect(moved.map((m) => m.name).sort()).toEqual(["agent-stale-1.key", "agent-stale-2.key"]);

    // Prunable files are gone from the original location...
    expect(existsSync(join(keysDir, "agent-stale-1.key"))).toBe(false);
    expect(existsSync(join(keysDir, "agent-stale-2.key"))).toBe(false);
    // ...and present in the archive.
    const archiveDir = join(keysDir, PRUNED_DIR_NAME, "2026-07-18");
    expect(existsSync(join(archiveDir, "agent-stale-1.key"))).toBe(true);
    expect(existsSync(join(archiveDir, "agent-stale-2.key"))).toBe(true);

    // flair#1026 — THE POINT OF THIS CHANGE: the unparseable file stays exactly
    // where it was. It may be a live keystore blob, and prune cannot tell.
    expect(existsSync(join(keysDir, "garbage.key"))).toBe(true);
    expect(existsSync(join(archiveDir, "garbage.key"))).toBe(false);

    // The registered agent's key is untouched, at its original path.
    expect(existsSync(join(keysDir, "agent-registered.key"))).toBe(true);
    expect(existsSync(join(archiveDir, "agent-registered.key"))).toBe(false);
  });

  it("a keystore-shaped blob named by the checked Instance table is never moved by --apply", async () => {
    const blob = Buffer.from(Array.from({ length: 60 }, (_, i) => (i * 7 + 3) & 0xff));
    writeFileSync(join(keysDir, "flair_deadbeef.key"), blob);
    const classified = await classifyKeysDir(keysDir, BASE_URL, instanceRows(["flair_deadbeef"]));
    const { moved } = applyKeyPrune(keysDir, classified.entries, "2026-07-18");
    expect(moved).toEqual([]);
    expect(existsSync(join(keysDir, "flair_deadbeef.key"))).toBe(true);
    expect(existsSync(join(keysDir, PRUNED_DIR_NAME))).toBe(false);
  });

  it("moving nothing (all keys registered) is a no-op — returns an empty list, no .pruned dir created", async () => {
    writeSeedKey(keysDir, "agent-registered");
    globalThis.fetch = mockRegistrationFetch(new Set(["agent-registered"]));
    const classified = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    const { moved } = applyKeyPrune(keysDir, classified.entries, "2026-07-18");
    expect(moved).toEqual([]);
    expect(existsSync(join(keysDir, PRUNED_DIR_NAME))).toBe(false);
    expect(existsSync(join(keysDir, "agent-registered.key"))).toBe(true);
  });

  it("a second prune on a same-named leftover the same day gets a numeric-suffixed archive name, never overwrites", async () => {
    writeSeedKey(keysDir, "agent-stray");
    globalThis.fetch = mockRegistrationFetch(new Set());
    const first = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    const { moved: firstMoved } = applyKeyPrune(keysDir, first.entries, "2026-07-18");
    expect(firstMoved).toHaveLength(1);

    // A fresh key happens to reuse the same agent id / filename (e.g. a
    // second run after `flair agent add agent-stray` was retried).
    writeSeedKey(keysDir, "agent-stray");
    const second = await classifyKeysDir(keysDir, BASE_URL, noInstanceRead);
    const { moved: secondMoved } = applyKeyPrune(keysDir, second.entries, "2026-07-18");
    expect(secondMoved).toHaveLength(1);
    expect(secondMoved[0].movedTo).toContain("agent-stray.key.2");

    const archiveDir = join(keysDir, PRUNED_DIR_NAME, "2026-07-18");
    expect(readdirSync(archiveDir).sort()).toEqual(["agent-stray.key", "agent-stray.key.2"]);
  });
});

// ─── --apply refuses a non-regular sidecar (flair#2286) ─────────────────────

describe("`flair keys prune --apply` reports a non-regular sidecar instead of moving it (flair#2286)", () => {
  it("a directory at the sidecar path: the key stays and the operator is told the path and its type", async () => {
    writeSeedKey(keysDir, "agent-stale");
    const sidecar = join(keysDir, `agent-stale.key${SEED_OWNER_SUFFIX}`);
    mkdirSync(sidecar);
    globalThis.fetch = mockRegistrationFetch(new Set());

    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      await program.parseAsync(
        ["keys", "prune", "--apply", "--keys-dir", keysDir, "--instance", BASE_URL],
        { from: "user" },
      );
    } finally {
      console.log = realLog;
    }

    const out = lines.join("\n");
    expect(out).toContain(sidecar);
    expect(out).toContain("directory");
    expect(out).toContain("not moved");
    expect(existsSync(join(keysDir, "agent-stale.key"))).toBe(true);
    expect(existsSync(join(keysDir, PRUNED_DIR_NAME))).toBe(false);
  });
});

// ─── CLI wiring ─────────────────────────────────────────────────────────────

describe("`flair keys prune` command wiring", () => {
  function findCommand(name: string) {
    return program.commands.find((c) => c.name() === name);
  }
  function findSubcommand(parent: string, child: string) {
    return findCommand(parent)?.commands.find((c) => c.name() === child);
  }
  function hasOption(cmd: any, flag: string): boolean {
    return cmd.options.some((o: any) => o.flags.includes(flag));
  }

  it("registers `flair keys prune` with --apply, --keys-dir, --instance, --port", () => {
    const prune = findSubcommand("keys", "prune");
    expect(prune).toBeDefined();
    expect(hasOption(prune, "--apply")).toBe(true);
    expect(hasOption(prune, "--keys-dir")).toBe(true);
    expect(hasOption(prune, "--instance")).toBe(true);
    expect(hasOption(prune, "--port")).toBe(true);
  });

  it("is dry-run by default — --apply is not a required option", () => {
    const prune = findSubcommand("keys", "prune");
    const applyOpt = prune!.options.find((o: any) => o.flags.includes("--apply"));
    expect(applyOpt?.required).toBeFalsy();
  });
});

// ─── real subprocess acceptance checks (need an observable process.exit) ───

interface RunResult { exitCode: number | null; stdout: string; stderr: string }

function runCLI(args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync("bun", [CLI_SOURCE, ...args], {
    env: { ...process.env, ...env },
    timeout: 10_000,
    encoding: "utf8",
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("flair keys prune — subprocess acceptance checks", () => {
  let isoHome: string;
  let subKeysDir: string;

  beforeEach(() => {
    isoHome = mkdtempSync(join(tmpdir(), "flair-keys-prune-home-"));
    subKeysDir = mkdtempSync(join(tmpdir(), "flair-keys-prune-cli-"));
  });

  afterEach(() => {
    rmSync(isoHome, { recursive: true, force: true });
    rmSync(subKeysDir, { recursive: true, force: true });
  });

  test("--data-dir is rejected as an unknown option", () => {
    writeFileSync(join(subKeysDir, "agent-stale.key"), "fixture");
    const r = runCLI(
      ["keys", "prune", "--apply", "--keys-dir", subKeysDir, "--data-dir", isoHome, "--instance", "http://127.0.0.1:1"],
      { HOME: isoHome },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown option '--data-dir'");
    expect(existsSync(join(subKeysDir, "agent-stale.key"))).toBe(true);
    expect(existsSync(join(subKeysDir, PRUNED_DIR_NAME))).toBe(false);
  }, 20_000);

  test("fresh/empty key dir: exits 0 without needing a reachable instance", { timeout: 20_000 }, () => {
    // Deliberately point --instance at a bogus, unroutable-fast address —
    // if this exits 0 it proves the empty-dir path never even tries to
    // reach it (there are zero .key files to check registration for).
    const r = runCLI(
      ["keys", "prune", "--keys-dir", subKeysDir, "--instance", "http://127.0.0.1:1"],
      { HOME: isoHome },
    );
    expect(r.exitCode).toBe(0);
  });

  test("unreachable instance: hard-aborts with a non-zero exit and moves nothing", { timeout: 20_000 }, () => {
    const kp = nacl.sign.keyPair();
    writeFileSync(join(subKeysDir, "agent-x.key"), Buffer.from(kp.secretKey.slice(0, 32)));

    // Port 1 is a privileged port nothing listens on locally — a fast,
    // reliable ECONNREFUSED without depending on any real Flair instance.
    const r = runCLI(
      ["keys", "prune", "--keys-dir", subKeysDir, "--instance", "http://127.0.0.1:1"],
      { HOME: isoHome },
    );
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(subKeysDir, "agent-x.key"))).toBe(true);
    expect(existsSync(join(subKeysDir, PRUNED_DIR_NAME))).toBe(false);
  });

  // flair#1026 prune-guard: the CLI must *report* an unparseable file as
  // unidentified and must not treat an unidentified-only dir as empty.
  // flair#1925: a NODE-shaped file's orphan status needs the Instance rows,
  // which this run does not read — the run says so and offers nothing as
  // orphan. No request is sent, so exit 0.
  test("unparseable .key is reported unidentified, not 'no key files found', and not pruned", { timeout: 30_000 }, () => {
    const blob = Buffer.from(Array.from({ length: 60 }, (_, i) => (i * 7 + 3) & 0xff));
    writeFileSync(join(subKeysDir, "flair_deadbeef.key"), blob);

    const dry = runCLI(
      ["keys", "prune", "--keys-dir", subKeysDir, "--instance", "http://127.0.0.1:1"],
      { HOME: isoHome },
    );
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("unidentified");
    expect(dry.stdout).toContain("left in place");
    expect(dry.stdout).not.toContain("No key files found");
    expect(dry.stdout).not.toMatch(/flair_deadbeef\.key — invalid/);
    // The orphan class was NOT offered, and the output says why.
    expect(dry.stdout).toContain("no orphan candidates determined");
    expect(dry.stdout).not.toContain("— orphan:");
    expect(existsSync(join(subKeysDir, "flair_deadbeef.key"))).toBe(true);

    const applied = runCLI(
      ["keys", "prune", "--apply", "--keys-dir", subKeysDir, "--instance", "http://127.0.0.1:1"],
      { HOME: isoHome },
    );
    expect(applied.exitCode).toBe(0);
    expect(applied.stdout).toContain("unidentified");
    expect(applied.stdout).toContain("left in place");
    expect(existsSync(join(subKeysDir, "flair_deadbeef.key"))).toBe(true);
    expect(existsSync(join(subKeysDir, PRUNED_DIR_NAME))).toBe(false);
  });
});
