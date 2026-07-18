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

const BASE_URL = "http://127.0.0.1:19926";
const CLI_SOURCE = join(__dirname, "..", "..", "src", "cli.ts");
const realFetch = globalThis.fetch;

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
    const res = await classifyKeysDir(nonExistent, BASE_URL);
    expect(res.aborted).toBe(false);
    expect(res.entries).toEqual([]);
    expect(called).toBe(false);
  });

  it("an existing but empty keysDir → not aborted, zero entries, no network call", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const res = await classifyKeysDir(keysDir, BASE_URL);
    expect(res.aborted).toBe(false);
    expect(res.entries).toEqual([]);
    expect(called).toBe(false);
  });

  it("a keysDir containing only ignored files (README, no .key files) → zero candidates, no network call", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;
    writeFileSync(join(keysDir, "README.md"), "not a key\n");
    mkdirSync(join(keysDir, "some-subdir"));
    const res = await classifyKeysDir(keysDir, BASE_URL);
    expect(res.aborted).toBe(false);
    expect(res.entries.every((e) => e.class === "ignored")).toBe(true);
    expect(called).toBe(false);
  });

  it("skips its own .pruned archive directory rather than treating it as a candidate", async () => {
    mkdirSync(join(keysDir, PRUNED_DIR_NAME, "2026-01-01"), { recursive: true });
    const res = await classifyKeysDir(keysDir, BASE_URL);
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

    const res = await classifyKeysDir(keysDir, BASE_URL);
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

describe("classifyKeysDir — invalid files classified distinctly from unregistered", () => {
  it("an unparseable .key file → class 'invalid', and never triggers a network call", async () => {
    writeFileSync(join(keysDir, "garbage.key"), "not-a-real-ed25519-seed-at-all");
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("{}", { status: 200 }); }) as typeof fetch;

    const res = await classifyKeysDir(keysDir, BASE_URL);
    expect(res.aborted).toBe(false);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].class).toBe("invalid");
    expect(res.entries[0].name).toBe("garbage.key");
    expect(called).toBe(false);
  });

  it("invalid and stale are both prunable but reported as distinct classes side by side", async () => {
    writeFileSync(join(keysDir, "garbage.key"), "not-a-real-ed25519-seed-at-all");
    writeSeedKey(keysDir, "agent-stale");
    globalThis.fetch = mockRegistrationFetch(new Set());

    const res = await classifyKeysDir(keysDir, BASE_URL);
    const byClass = Object.fromEntries(res.entries.map((e) => [e.name, e.class]));
    expect(byClass["garbage.key"]).toBe("invalid");
    expect(byClass["agent-stale.key"]).toBe("stale");
  });
});

describe("classifyKeysDir — unreachable instance aborts the whole run", () => {
  it("a network failure on the registration check aborts before classifying anything, nothing moved", async () => {
    writeSeedKey(keysDir, "agent-a");
    writeSeedKey(keysDir, "agent-b");
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;

    const res = await classifyKeysDir(keysDir, BASE_URL);
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
  it("moves exactly the stale + invalid entries into .pruned/<date>/, a registered agent's key is NEVER moved", async () => {
    writeSeedKey(keysDir, "agent-stale-1");
    writeSeedKey(keysDir, "agent-stale-2");
    writeSeedKey(keysDir, "agent-registered");
    writeFileSync(join(keysDir, "garbage.key"), "not-a-real-ed25519-seed-at-all");
    globalThis.fetch = mockRegistrationFetch(new Set(["agent-registered"]));

    const classified = await classifyKeysDir(keysDir, BASE_URL);
    expect(classified.aborted).toBe(false);

    const moved = applyKeyPrune(keysDir, classified.entries, "2026-07-18");
    expect(moved).toHaveLength(3);
    expect(moved.map((m) => m.name).sort()).toEqual(["agent-stale-1.key", "agent-stale-2.key", "garbage.key"]);

    // Prunable files are gone from the original location...
    expect(existsSync(join(keysDir, "agent-stale-1.key"))).toBe(false);
    expect(existsSync(join(keysDir, "agent-stale-2.key"))).toBe(false);
    expect(existsSync(join(keysDir, "garbage.key"))).toBe(false);
    // ...and present in the archive.
    const archiveDir = join(keysDir, PRUNED_DIR_NAME, "2026-07-18");
    expect(existsSync(join(archiveDir, "agent-stale-1.key"))).toBe(true);
    expect(existsSync(join(archiveDir, "agent-stale-2.key"))).toBe(true);
    expect(existsSync(join(archiveDir, "garbage.key"))).toBe(true);

    // The registered agent's key is untouched, at its original path.
    expect(existsSync(join(keysDir, "agent-registered.key"))).toBe(true);
    expect(existsSync(join(archiveDir, "agent-registered.key"))).toBe(false);
  });

  it("moving nothing (all keys registered) is a no-op — returns an empty list, no .pruned dir created", async () => {
    writeSeedKey(keysDir, "agent-registered");
    globalThis.fetch = mockRegistrationFetch(new Set(["agent-registered"]));
    const classified = await classifyKeysDir(keysDir, BASE_URL);
    const moved = applyKeyPrune(keysDir, classified.entries, "2026-07-18");
    expect(moved).toEqual([]);
    expect(existsSync(join(keysDir, PRUNED_DIR_NAME))).toBe(false);
    expect(existsSync(join(keysDir, "agent-registered.key"))).toBe(true);
  });

  it("a second prune on a same-named leftover the same day gets a numeric-suffixed archive name, never overwrites", async () => {
    writeSeedKey(keysDir, "agent-stray");
    globalThis.fetch = mockRegistrationFetch(new Set());
    const first = await classifyKeysDir(keysDir, BASE_URL);
    const firstMoved = applyKeyPrune(keysDir, first.entries, "2026-07-18");
    expect(firstMoved).toHaveLength(1);

    // A fresh key happens to reuse the same agent id / filename (e.g. a
    // second run after `flair agent add agent-stray` was retried).
    writeSeedKey(keysDir, "agent-stray");
    const second = await classifyKeysDir(keysDir, BASE_URL);
    const secondMoved = applyKeyPrune(keysDir, second.entries, "2026-07-18");
    expect(secondMoved).toHaveLength(1);
    expect(secondMoved[0].movedTo).toContain("agent-stray.key.2");

    const archiveDir = join(keysDir, PRUNED_DIR_NAME, "2026-07-18");
    expect(readdirSync(archiveDir).sort()).toEqual(["agent-stray.key", "agent-stray.key.2"]);
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

  test("fresh/empty key dir: exits 0 without needing a reachable instance", () => {
    // Deliberately point --instance at a bogus, unroutable-fast address —
    // if this exits 0 it proves the empty-dir path never even tries to
    // reach it (there are zero .key files to check registration for).
    const r = runCLI(
      ["keys", "prune", "--keys-dir", subKeysDir, "--instance", "http://127.0.0.1:1"],
      { HOME: isoHome },
    );
    expect(r.exitCode).toBe(0);
  });

  test("unreachable instance: hard-aborts with a non-zero exit and moves nothing", () => {
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
});
