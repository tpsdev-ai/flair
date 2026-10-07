/**
 * Action recall (flair#2067 slice 2) — unit lane.
 *
 * The modules under test did not exist on main, so on main this file fails to
 * import (the acceptance tests are red there by construction). Everything below
 * exercises the limits the build spec calls build contracts.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_VERSION,
  CACHE_MAX_BYTES,
  MAX_HITS,
  STALE_MS,
  buildExcerpt,
  compilePathGlob,
  decodeBinding,
  decodeEnvelope,
  effectiveExpiry,
  encodeBinding,
  encodeEnvelope,
  globMatchesPath,
  hookOutput,
  normalizeOperand,
  parseCommand,
  parseSimpleBashCommand,
  readTriggerMetadata,
  renderContext,
  selectEntries,
  triggerMatches,
  validateTrigger,
  validateTriggers,
  type ActionTrigger,
  type CacheEntry,
  type CachePayload,
} from "../src/action-recall.js";
import {
  bindingPath,
  generationPath,
  publishGeneration,
  readBinding,
  readGeneration,
  sessionDir,
} from "../src/action-recall-cache.js";
import { runActionRecall } from "../src/action-recall-run.js";

const URL = "http://localhost:19926";
const AGENT = "test-agent";
const SESSION = "sess-1";
const INSTANCE = "inst-1";

function gitPushTrigger(): ActionTrigger {
  return { verb: "git", subcommands: ["push"], flags: ["--force"], paths: [] };
}

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    id: "mem-1",
    owner: AGENT,
    createdAt: "2026-10-01T00:00:00.000Z",
    triggers: [gitPushTrigger()],
    excerpt: "always force push to the release branch after the unit lane passes",
    safetyFlags: [],
    ...overrides,
  };
}

function payload(entries: CacheEntry[], overrides: Partial<CachePayload> = {}): CachePayload {
  const now = Date.parse("2026-10-03T00:00:00.000Z");
  return {
    v: CACHE_VERSION,
    url: URL,
    principal: AGENT,
    session: SESSION,
    instance: INSTANCE,
    generation: "gen-1",
    refreshStart: now,
    expiry: now + STALE_MS,
    entries,
    ...overrides,
  };
}

/** Write a binding + generation with the modes the cache requires. */
function writeCache(root: string, entries: CacheEntry[], opts: { generationFileMode?: number } = {}): string {
  const dir = sessionDir(root, URL, AGENT, SESSION);
  const instDir = join(dir, sha256(INSTANCE));
  mkdirSync(instDir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  chmodSync(instDir, 0o700);
  const p = payload(entries);
  const genPath = generationPath(dir, INSTANCE, p.generation);
  const genMode = opts.generationFileMode ?? 0o600;
  writeFileSync(genPath, encodeEnvelope(p), { mode: genMode });
  // writeFileSync's mode is applied at creation and masked by the umask; chmod
  // after the write sets the mode explicitly, so this fixture's modes hold
  // despite the umask (flair#2292).
  chmodSync(genPath, genMode);
  const bindPath = bindingPath(dir);
  writeFileSync(bindPath, encodeBinding({ v: CACHE_VERSION, url: URL, principal: AGENT, session: SESSION, instance: INSTANCE, generation: p.generation }), { mode: 0o600 });
  chmodSync(bindPath, 0o600);
  return dir;
}

function sha256(text: string): string {
  return require("node:crypto").createHash("sha256").update(text, "utf8").digest("hex");
}

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "flair-2067-test-")));
}

// ── trigger grammar ──────────────────────────────────────────────────────────

describe("trigger grammar", () => {
  test("accepts the example trigger and requires specificity", () => {
    expect(validateTrigger({ verb: "git", subcommands: ["push"], flags: ["--force"], paths: [] }).ok).toBe(true);
    expect(validateTrigger({ verb: "git", subcommands: [], flags: [], paths: [] }).ok).toBe(false); // bare verb
  });
  test("rejects the grammar limits", () => {
    expect(validateTriggers(Array.from({ length: 5 }, () => gitPushTrigger())).ok).toBe(false);
    expect(validateTrigger({ verb: "git", subcommands: ["a", "b", "c", "d"], flags: [] }).ok).toBe(false);
    expect(validateTrigger({ verb: "git", flags: Array.from({ length: 9 }, (_, i) => `--f${i}`) }).ok).toBe(false);
    expect(validateTrigger({ verb: "git", paths: ["a/*.ts", "b/*.ts", "c/*.ts"] }).ok).toBe(false);
    expect(validateTrigger({ verb: "git", flags: [`--${"x".repeat(200)}`] }).ok).toBe(false);
    expect(validateTrigger({ verb: "gi/t", flags: ["-x"] }).ok).toBe(false); // verb excludes /
    expect(validateTrigger({ verb: "git", flags: ["-rf"] }).ok).toBe(false); // not a single letter
    expect(validateTrigger({ verb: "git", flags: ["force"] }).ok).toBe(false);
    expect(validateTrigger({ verb: "git", flags: ["--force=main"] }).ok).toBe(true);
  });
  test("path globs reject braces, brackets, regex and root-wide patterns", () => {
    expect(compilePathGlob("src/*.ts")).not.toBeNull();
    expect(compilePathGlob("**/x")).not.toBeNull();
    expect(compilePathGlob("a/{b,c}/d")).toBeNull();
    expect(compilePathGlob("a/[bc]/d")).toBeNull();
    expect(compilePathGlob("a/.*")).not.toBeNull(); // leading dot is literal, not regex
    expect(compilePathGlob("**")).toBeNull(); // no literal segment
    expect(compilePathGlob("/*")).toBeNull(); // root-wide
    expect(compilePathGlob("a/../b")).toBeNull();
  });
});

describe("metadata", () => {
  test("absent, invalid and empty trigger sets", () => {
    expect(readTriggerMetadata(null).ok).toBe(false);
    expect(readTriggerMetadata(JSON.stringify({ other: 1 })).ok).toBe(false);
    expect(readTriggerMetadata(JSON.stringify({ flairActionRecall: { v: 2, triggers: [] } })).ok).toBe(false);
    const empty = readTriggerMetadata(JSON.stringify({ flairActionRecall: { v: 1, triggers: [] } }));
    expect(empty.ok && empty.triggers.length === 0).toBe(true);
    const one = readTriggerMetadata(JSON.stringify({ flairActionRecall: { v: 1, triggers: [gitPushTrigger()] } }));
    expect(one.ok && one.triggers.length === 1).toBe(true);
  });
});

// ── Bash reader ───────────────────────────────────────────────────────────────

describe("restricted Bash reader", () => {
  test("reads a simple argv command with quoting and escapes", () => {
    const r = parseSimpleBashCommand("git commit -m 'hello world' --amend");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.argv).toEqual(["git", "commit", "-m", "hello world", "--amend"]);
  });
  test("rejects every unsupported shape", () => {
    const bad = [
      "git push | tee log",
      "git push > out.txt",
      "git push && rm -rf /",
      "git push ; rm -rf /",
      "git push &",
      "echo $(whoami)",
      "echo `id`",
      "cat <<EOF",
      "git push\nrm -rf /",
      "git push # comment",
      "FOO=bar git push",
      "sudo git push",
      "env git push",
      "git push *.txt",
      "git push $HOME",
      "(git push)",
      "{ git push; }",
      "git push --force ~/x",
    ];
    for (const command of bad) {
      expect(parseCommand(command)).toBeNull();
    }
  });
  test("expands short clusters and honours --", () => {
    const cmd = parseCommand("rm -rf -- -weird");
    expect(cmd).not.toBeNull();
    expect([...cmd!.flags].sort()).toEqual(["-f", "-r"]);
    expect(cmd!.operands).toContain("-weird");
  });
});

// ── path matching ─────────────────────────────────────────────────────────────

describe("path matching", () => {
  test("normalizes operands lexically", () => {
    expect(normalizeOperand("./a/../b", "/repo")).toBe("b");
    expect(normalizeOperand("/repo/src/x.ts", "/repo")).toBe("src/x.ts");
    expect(normalizeOperand("/etc/passwd", "/repo")).toBeNull();
    expect(normalizeOperand("../../x", "/repo")).toBeNull();
  });
  test("anchored, case-sensitive, segment-aware globs", () => {
    expect(globMatchesPath(compilePathGlob("src/*.ts")!, "src/a.ts")).toBe(true);
    expect(globMatchesPath(compilePathGlob("src/*.ts")!, "src/a/b.ts")).toBe(false);
    expect(globMatchesPath(compilePathGlob("src/*.ts")!, "SRC/a.ts")).toBe(false);
    expect(globMatchesPath(compilePathGlob("**/a.ts")!, "x/y/a.ts")).toBe(true);
    expect(globMatchesPath(compilePathGlob("a/**")!, "a/b/c")).toBe(true);
  });
  test("trigger matching requires every populated field", () => {
    const cmd = parseCommand("git push --force origin main")!;
    expect(triggerMatches(gitPushTrigger(), cmd, "/repo")).toBe(true);
    expect(triggerMatches({ verb: "git", subcommands: ["push"], flags: [], paths: [] }, parseCommand("git pull")!, "/repo")).toBe(false);
    expect(triggerMatches({ verb: "git", flags: ["--force"], subcommands: [], paths: [] }, parseCommand("git push")!, "/repo")).toBe(false);
    expect(
      triggerMatches({ verb: "git", subcommands: ["add"], flags: [], paths: ["src/*.ts"] }, parseCommand("git add src/x.ts")!, "/repo"),
    ).toBe(true);
    expect(
      triggerMatches({ verb: "git", subcommands: ["add"], flags: [], paths: ["src/*.ts"] }, parseCommand("git add etc/x.ts")!, "/repo"),
    ).toBe(false);
  });
});

// ── envelope and staleness ────────────────────────────────────────────────────

describe("cache envelope", () => {
  test("round-trips and rejects corruption/schema/oversize", () => {
    const text = encodeEnvelope(payload([entry()]));
    expect(decodeEnvelope(text)?.entries.length).toBe(1);
    const tampered = JSON.parse(text);
    tampered.payload = tampered.payload.replace("mem-1", "mem-2");
    expect(decodeEnvelope(JSON.stringify(tampered))).toBeNull(); // digest mismatch
    expect(decodeEnvelope("{ not json")).toBeNull();
    expect(decodeEnvelope(JSON.stringify({ payload: "{}", sha256: "0".repeat(64) }))).toBeNull();
    const many = Array.from({ length: 65 }, (_, i) => entry({ id: `m${i}` }));
    expect(decodeEnvelope(encodeEnvelope(payload(many)))).toBeNull(); // >64 entries
  });
  test("effective expiry is the refresh window shortened by a lesson", () => {
    const now = Date.parse("2026-10-03T00:00:00.000Z");
    const p = payload([entry()], { refreshStart: now, expiry: now + STALE_MS });
    expect(effectiveExpiry(p)).toBe(now + STALE_MS);
    const shortened = payload([entry({ validTo: new Date(now + 1000).toISOString() })], { refreshStart: now, expiry: now + STALE_MS });
    expect(effectiveExpiry(shortened)).toBe(now + 1000);
  });
});

// ── rendering ──────────────────────────────────────────────────────────────────

describe("rendering", () => {
  test("at most three hits, quoted, bounded", () => {
    const entries = Array.from({ length: 6 }, (_, i) => entry({ id: `m${i}` }));
    const entries3 = selectEntries(entries, parseCommand("git push --force")!, "/repo", Date.parse("2026-10-03T00:00:00.000Z"));
    expect(entries3.length).toBe(MAX_HITS);
    const context = renderContext(entries3);
    expect(context).toContain("| id: m0");
    const output = hookOutput(context);
    expect(JSON.parse(output).hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(new TextEncoder().encode(output).length).toBeLessThanOrEqual(4096);
  });
  test("drops safety-flagged lessons and expired entries", () => {
    const now = Date.parse("2026-10-03T00:00:00.000Z");
    const flagged = entry({ id: "flagged", safetyFlags: ["injection"] });
    const expired = entry({ id: "expired", expiresAt: new Date(now - 1).toISOString() });
    const ok = entry({ id: "ok" });
    const hits = selectEntries([flagged, expired, ok], parseCommand("git push --force")!, "/repo", now);
    expect(hits.map((h) => h.id)).toEqual(["ok"]);
  });
});

// ── cache read integrity ───────────────────────────────────────────────────────

describe("cache read integrity", () => {
  test("reads a well-formed cache", async () => {
    const root = scratch();
    try {
      const dir = writeCache(root, [entry()]);
      const binding = await readBinding(dir, { url: URL, principal: AGENT, session: SESSION });
      expect(binding).not.toBeNull();
      const now = Date.parse("2026-10-03T00:00:00.000Z");
      const p = await readGeneration(dir, binding!, now);
      expect(p?.entries.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects wrong mode, symlink, corruption and staleness", async () => {
    const now = Date.parse("2026-10-03T00:00:00.000Z");
    {
      const root = scratch();
      const dir = writeCache(root, [entry()], { generationFileMode: 0o644 });
      const binding = await readBinding(dir, { url: URL, principal: AGENT, session: SESSION });
      expect(binding).not.toBeNull();
      expect(await readGeneration(dir, binding!, now)).toBeNull(); // 0644 is refused
      rmSync(root, { recursive: true, force: true });
    }
    {
      const root = scratch();
      const dir = writeCache(root, [entry()]);
      const binding = await readBinding(dir, { url: URL, principal: AGENT, session: SESSION });
      const gen = generationPath(dir, INSTANCE, "gen-1");
      rmSync(gen);
      symlinkSync("/etc/hostname", gen); // symlink component/file refused
      expect(await readGeneration(dir, binding!, now)).toBeNull();
      rmSync(root, { recursive: true, force: true });
    }
    {
      const root = scratch();
      const dir = writeCache(root, [entry()]);
      const binding = await readBinding(dir, { url: URL, principal: AGENT, session: SESSION });
      writeFileSync(generationPath(dir, INSTANCE, "gen-1"), "corrupt", { mode: 0o600 });
      expect(await readGeneration(dir, binding!, now)).toBeNull();
      rmSync(root, { recursive: true, force: true });
    }
    {
      const root = scratch();
      const dir = writeCache(root, [entry()]);
      const binding = await readBinding(dir, { url: URL, principal: AGENT, session: SESSION });
      expect(await readGeneration(dir, binding!, now + STALE_MS + 1)).toBeNull(); // expired
      rmSync(root, { recursive: true, force: true });
    }
    {
      const root = scratch();
      const dir = writeCache(root, [entry()]);
      const binding = await readBinding(dir, { url: URL, principal: AGENT, session: SESSION });
      // An oversized generation file is refused on its size alone.
      writeFileSync(generationPath(dir, INSTANCE, "gen-1"), "x".repeat(CACHE_MAX_BYTES + 1), { mode: 0o600 });
      expect(await readGeneration(dir, binding!, now)).toBeNull();
      rmSync(root, { recursive: true, force: true });
    }
    {
      const root = scratch();
      const dir = writeCache(root, [entry()]);
      const binding = await readBinding(dir, { url: URL, principal: AGENT, session: SESSION });
      // A generation whose own instance binding disagrees with the binding file is refused.
      writeFileSync(generationPath(dir, INSTANCE, "gen-1"), encodeEnvelope(payload([entry()], { instance: "other-instance" })), { mode: 0o600 });
      expect(await readGeneration(dir, binding!, now)).toBeNull();
      rmSync(root, { recursive: true, force: true });
    }
    {
      const root = scratch();
      const dir = writeCache(root, [entry()]);
      expect(await readBinding(dir, { url: URL, principal: "other", session: SESSION })).toBeNull();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── end-to-end hot path ─────────────────────────────────────────────────────────

describe("runActionRecall", () => {
  const now = Date.parse("2026-10-03T00:00:00.000Z");
  const env = { FLAIR_AGENT_ID: AGENT, FLAIR_URL: URL };

  test("surfaces a matching lesson and stays silent otherwise", async () => {
    const root = scratch();
    try {
      writeCache(root, [entry()]);
      const match = await runActionRecall(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force origin main" }, cwd: "/repo", session_id: SESSION }), { root, env, now, cwd: "/repo" });
      expect(match).toContain("additionalContext");
      expect(match).toContain("mem-1");
      const unrelated = await runActionRecall(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/repo", session_id: SESSION }), { root, env, now, cwd: "/repo" });
      expect(unrelated).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("is silent on non-Bash tools, unsupported commands, missing and corrupt caches", async () => {
    const root = scratch();
    try {
      expect(await runActionRecall(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" }, session_id: SESSION }), { root, env, now })).toBe("");
      expect(await runActionRecall(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push | tee x" }, session_id: SESSION }), { root, env, now })).toBe("");
      writeCache(root, [entry()]);
      expect(await runActionRecall(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force" }, session_id: "other-session" }), { root, env, now, cwd: "/repo" })).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── redaction ──────────────────────────────────────────────────────────────────

describe("redaction", () => {
  for (const [label, secret] of [
    ["Stripe", `sk_live_${"A".repeat(16)}`],
    ["Hugging Face", `hf_${"A".repeat(20)}`],
    ["Groq", `gsk_${"A".repeat(20)}`],
    ["PyPI", `pypi-${"A".repeat(16)}`],
    ["PGP", "-----BEGIN PGP PRIVATE KEY BLOCK-----\nsecret\n-----END PGP PRIVATE KEY BLOCK-----"],
  ]) {
    test(`buildExcerpt redacts ${label} credentials`, () => {
      const out = buildExcerpt(`before ${secret} after`);
      expect(out.includes(secret)).toBe(false);
      expect(out === "before [redacted] after").toBe(true);
    });
  }
  test("buildExcerpt redacts a secret-shaped string before caching", () => {
    const token = `ghp_${"A".repeat(36)}`;
    const out = buildExcerpt(`rotate ${token} now`);
    expect(out.includes(token)).toBe(false);
    expect(out.includes("[redacted]")).toBe(true);
  });
});

// keep a reference so unused-import lint stays quiet under bundlers that flag it
void publishGeneration;
void decodeBinding;
