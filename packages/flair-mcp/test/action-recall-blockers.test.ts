import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishGeneration, readBinding, sessionDir } from "../src/action-recall-cache.ts";
import { refreshActionRecallCache } from "../src/action-recall-refresh.ts";
import { parseCommand, parseSimpleBashCommand, sha256Hex, triggerMatches, type CacheEntry, type CachePayload } from "../src/action-recall.ts";
import { runActionRecall } from "../src/action-recall-run.ts";

let root: string;
const url = "http://localhost:19926", principal = "me", session = "s", instance = "i";
const now = Date.parse("2026-10-03T00:00:00Z");
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "flair-recall-regression-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const dir = () => sessionDir(root, url, principal, session);
const entry = (extra: Partial<CacheEntry> = {}): CacheEntry => ({ id: "lesson", owner: principal, triggers: [{ verb: "git", subcommands: ["push"], flags: [], paths: [] }], excerpt: "keep the release branch", safetyFlags: [], ...extra });
const payload = (entries: CacheEntry[], extra: Partial<CachePayload> = {}): CachePayload => ({ v: 1, url, principal, session, instance, generation: "g", refreshStart: now, expiry: now + 300_000, entries, ...extra });
const run = () => runActionRecall(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, session_id: session }), { root, now, env: { FLAIR_AGENT_ID: principal, FLAIR_URL: url } });
const client = (rows: unknown) => ({ bootstrap: async () => ({}), request: async <T>(_: string, path: string): Promise<T> => (path === "/Instance" ? [{ id: instance }] : rows) as T });
const opts = () => ({ root, now, agentId: principal, url, session, bootstrapResult: { scope: { agentId: principal, isAdmin: false } } });

test("refresh refuses unknown successful response shapes instead of publishing an empty list", async () => {
  for (const rows of [{}, null, { results: {} }, { results: null }, "", [null], ["row"], [{}]]) {
    const result = await refreshActionRecallCache(client(rows), opts());
    expect(result.ok).toBe(false);
    expect(await readBinding(dir(), { url, principal, session })).toBeNull();
  }
  expect((await refreshActionRecallCache(client({ results: [] }), opts())).ok).toBe(true);
  expect((await refreshActionRecallCache(client([]), opts())).ok).toBe(true);
});

for (const delayedFile of ["generation", "binding"]) {
  test(`a deadline during ${delayedFile} publication cannot publish or bind late`, async () => {
    // The deadline has to outlast directory creation and the earlier write.
    // A 50 ms budget expired before binding sync on the node 26 shared lane
    // (pre-sync work ~115 ms), so `delayed` stayed false. The stall is the
    // whole budget, measured from refresh start, so sync still lands past it.
    const deadlineMs = 2_000;
    const realOpen = fs.open;
    let delayed = false;
    const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const path = String(args[0]);
      if (path.includes(".tmp-") && path.includes("current.json") === (delayedFile === "binding")) {
        const realSync = handle.sync.bind(handle);
        handle.sync = async () => {
          delayed = true;
          await realSync();
          await new Promise(resolve => setTimeout(resolve, deadlineMs));
        };
      }
      return handle;
    });
    try {
      const result = await refreshActionRecallCache(client([]), { ...opts(), deadlineMs });
      expect(delayed).toBe(true);
      expect(result).toEqual({ ok: false, reason: "timeout" });
      expect(await readBinding(dir(), { url, principal, session })).toBeNull();
      if (delayedFile === "generation") expect(await fs.readdir(join(dir(), sha256Hex(instance)))).toEqual([]);
    } finally { openSpy.mockRestore(); }
  }, 15_000);
}

test("double-quote backslashes preserve non-special characters and match the real argv", () => {
  const command = String.raw`git "a\q"`;
  expect(parseSimpleBashCommand(command)).toEqual({ ok: true, argv: ["git", String.raw`a\q`] });
  const parsed = parseCommand(command)!;
  expect(triggerMatches({ verb: "git", subcommands: [String.raw`a\q`], flags: [], paths: [] }, parsed, "/repo")).toBe(true);
  expect(triggerMatches({ verb: "git", subcommands: ["aq"], flags: [], paths: [] }, parsed, "/repo")).toBe(false);
});

test("double quotes escape only dollar, backtick, quote, backslash and newline", () => {
  for (const [escaped, literal] of [["\\$x", "$x"], ["\\`", "`"], ['\\"', '"'], ["\\\\", "\\"], ["\\q", "\\q"]]) {
    expect(parseSimpleBashCommand('git "' + escaped + '"')).toEqual({ ok: true, argv: ["git", literal] });
  }
  expect(parseSimpleBashCommand('git "pu\\\nsh"')).toEqual({ ok: true, argv: ["git", "push"] });
  for (const command of [String.raw`git "\q$x"`, 'git "\\q`id`"']) expect(parseSimpleBashCommand(command).ok).toBe(false);
});

test("runActionRecall applies the five-minute effective generation expiry", async () => {
  await publishGeneration(dir(), payload([entry()], { refreshStart: now - 300_001, expiry: now + 300_000 }));
  expect(await run()).toBe("");
});

test("one expired lesson shortens the whole cache expiry in runActionRecall", async () => {
  await publishGeneration(dir(), payload([entry(), entry({ id: "other", validTo: new Date(now - 1).toISOString() })]));
  expect(await run()).toBe("");
});

test("runActionRecall redacts the complete rendered hit, including id and timestamp", async () => {
  const secret = "sk-" + "A".repeat(40);
  await publishGeneration(dir(), payload([entry({ id: secret, createdAt: secret, provenance: secret, excerpt: secret })]));
  const out = await run();
  expect(out).toContain("[redacted]");
  expect(out).not.toContain(secret);
  expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("PreToolUse");
});
