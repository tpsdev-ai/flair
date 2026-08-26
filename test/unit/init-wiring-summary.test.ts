import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderWiringSummary,
  detectClients,
  clientConfigPath,
  type WiringOutcome,
} from "../../src/install/clients.ts";

/**
 * flair#906 — `flair init --client all` reported success for Claude Code on a
 * machine where Claude Code was installed but had never been run.
 *
 * Two separate failures:
 *   1. Detection asked the wrong question. It ran `npm list -g
 *      @anthropic-ai/claude-code`, but Claude Code's native installer puts
 *      `claude` on PATH without registering an npm global.
 *   2. Even when it did try, an absent ~/.claude.json downgraded the wiring to
 *      a printed snippet — and that outcome was recorded in `wiringResults`
 *      ("snippet printed (no ~/.claude.json)") but never surfaced as something
 *      the user could act on after the command finished. `all` is a promise;
 *      partially keeping it without saying so is the defect.
 */

let isoHome: string;
let prevHome: string | undefined;
let prevPath: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-summary-home-"));
  prevHome = process.env.HOME;
  prevPath = process.env.PATH;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  if (prevPath !== undefined) process.env.PATH = prevPath;
  else delete process.env.PATH;
  rmSync(isoHome, { recursive: true, force: true });
});

const wired = (client: string, message = "wired"): WiringOutcome => ({ client, message, wired: true });
const notWired = (client: string, message: string): WiringOutcome => ({ client, message, wired: false });

const LABELS = new Map([
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["gemini", "Gemini"],
]);

/** All summary text as one blob — what the user actually sees. */
const textOf = (lines: { text: string }[]) => lines.map(l => l.text).join("\n");

describe("renderWiringSummary — a client that was NOT wired stays visible", () => {
  it("names the not-wired client, separately from the wired ones", () => {
    // The exact shape from the bug report: Codex wired, Claude Code not.
    const lines = renderWiringSummary(
      [wired("codex", "wired ~/.codex/config.toml"), notWired("claude-code", "snippet printed (no ~/.claude.json)")],
      { labels: LABELS },
    );

    const errorLines = lines.filter(l => l.level === "error");
    expect(errorLines.length).toBe(1);
    expect(errorLines[0].text).toContain("NOT wired");
    expect(errorLines[0].text).toContain("Claude Code");
    // The reason travels with it — an error the user cannot respond to is
    // just noise.
    expect(errorLines[0].text).toContain("snippet printed (no ~/.claude.json)");

    // ...and it is not smuggled into the wired list.
    const okLines = lines.filter(l => l.level === "ok");
    expect(okLines.length).toBe(1);
    expect(okLines[0].text).toContain("Codex");
    expect(okLines[0].text).not.toContain("Claude Code");
  });

  it("warns that manual wiring is outstanding, with a count", () => {
    const lines = renderWiringSummary(
      [wired("codex"), notWired("claude-code", "snippet printed"), notWired("gemini", "could not write")],
      { labels: LABELS },
    );
    const warnText = lines.filter(l => l.level === "warn").map(l => l.text).join("\n");
    expect(warnText).toContain("2 client(s) need manual wiring");
  });

  it("says nothing alarming when everything asked for was wired", () => {
    const lines = renderWiringSummary([wired("codex"), wired("claude-code")], { labels: LABELS });
    expect(lines.filter(l => l.level === "error").length).toBe(0);
    expect(lines.filter(l => l.level === "warn").length).toBe(0);
    expect(textOf(lines)).toContain("Wired: Codex, Claude Code");
  });

  it("accounts for clients --client all passed over as not installed", () => {
    const lines = renderWiringSummary([wired("codex")], {
      labels: LABELS,
      skippedUndetected: ["Gemini", "Cursor"],
    });
    const muted = lines.filter(l => l.level === "muted");
    expect(muted.length).toBe(1);
    expect(muted[0].text).toContain("Not installed, skipped: Gemini, Cursor");
    // Skipped-because-absent is NOT the same as failed-to-wire.
    expect(lines.filter(l => l.level === "error").length).toBe(0);
  });

  it("tells the user what to run when nothing at all got wired", () => {
    const lines = renderWiringSummary([], {
      labels: LABELS,
      skippedUndetected: ["Claude Code"],
      rewireHint: "flair init --agent bob --client all",
    });
    const warnText = lines.filter(l => l.level === "warn").map(l => l.text).join("\n");
    expect(warnText).toContain("No MCP client was wired");
    expect(warnText).toContain("flair init --agent bob --client all");
  });

  it("surfaces an unpinned spec in the summary too (flair#907)", () => {
    const lines = renderWiringSummary([wired("codex")], { labels: LABELS, unpinned: true });
    expect(textOf(lines)).toContain("UNPINNED");
  });

  it("renders nothing at all when there was no wiring to report", () => {
    expect(renderWiringSummary([])).toEqual([]);
  });

  it("falls back to the raw client id when no label is known", () => {
    const lines = renderWiringSummary([notWired("some-new-client", "nope")]);
    expect(textOf(lines)).toContain("some-new-client");
  });
});

describe("Claude Code detection fires from the binary alone (flair#906); config is a second signal (flair#1417)", () => {
  /** Put an executable named `name` in `dir` and make `dir` the entire PATH. */
  function fakeBinOnPath(dir: string, name: string) {
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\nexit 0\n");
    chmodSync(p, 0o755);
    process.env.PATH = dir;
  }

  it("detects Claude Code from the `claude` binary with no ~/.claude.json present", () => {
    fakeBinOnPath(isoHome, "claude");
    // The precise condition from the bug report: installed, never run.
    expect(existsSync(join(isoHome, ".claude.json"))).toBe(false);

    const claudeCode = detectClients().find(c => c.id === "claude-code")!;
    expect(claudeCode.detected).toBe(true);
  });

  it("does not detect Claude Code when the binary and ~/.claude.json are both absent", () => {
    // Empty PATH: no `claude` anywhere, isolated HOME: no config file.
    // The config-path signal (flair#1417) is a second presence check, not
    // a default-true; this is the negative case end to end.
    process.env.PATH = isoHome;
    const claudeCode = detectClients().find(c => c.id === "claude-code")!;
    expect(claudeCode.detected).toBe(false);
  });

  it("reports NO client detected when PATH holds none of their binaries and no config exists", () => {
    // The Gemini false positive: detection used to fall back to
    // `npm list -g @google/generative-ai`, which exits 0 when that package is
    // anywhere in the global tree — including as a transitive dependency of an
    // unrelated global tool. Gemini was then reported installed, and
    // ~/.gemini/settings.json written, on a machine with no `gemini` binary.
    // Detection asks PATH or a known config file (flair#1417) — never a
    // global-tree walk — so the answer cannot depend on what else happens
    // to be installed globally. Isolated HOME means no config files either.
    process.env.PATH = isoHome;
    for (const client of detectClients()) {
      expect(`${client.id}=${client.detected}`).toBe(`${client.id}=false`);
    }
  });

  it("detects a client purely from its own binary, never a sibling's", () => {
    fakeBinOnPath(isoHome, "gemini");
    const byId = new Map(detectClients().map(c => [c.id, c.detected]));
    expect(byId.get("gemini")).toBe(true);
    expect(byId.get("claude-code")).toBe(false);
    expect(byId.get("codex")).toBe(false);
    expect(byId.get("cursor")).toBe(false);
  });
});

describe("client detection is bounded — it never shells out (flair#906 follow-up)", () => {
  /**
   * Detection runs on `flair init`, an interactive first-run path, so its cost
   * has to be bounded by construction rather than by luck.
   *
   * It used to fall back to `npm list -g <pkg>` for three of the four clients
   * whenever their binary was absent — an unbounded subprocess that walks the
   * entire global package tree, measured at ~800 ms per call on a warm
   * developer machine. A user with none of these clients installed paid up to
   * three of those in silence, and on a loaded CI runner the same calls pushed
   * a sibling test past its 5 s timeout.
   *
   * PATH here contains no client binary at all, which is precisely the case
   * that triggered every fallback — the most expensive path detection has.
   * Filesystem-only detection measures ~0.04 ms per call, so the budget below
   * sits several hundred times above real cost while remaining far under what
   * even a single npm spawn per iteration would need (~9 s at the fastest
   * spawn time we have observed on CI). Restoring any subprocess to the
   * detection path fails this test rather than merely making it flaky.
   */
  const ITERATIONS = 40;
  const BUDGET_MS = 1000;

  it(`runs ${ITERATIONS} full detection passes well inside ${BUDGET_MS}ms`, () => {
    process.env.PATH = isoHome;

    const started = performance.now();
    for (let i = 0; i < ITERATIONS; i++) detectClients();
    const elapsed = performance.now() - started;

    expect({ overBudget: elapsed > BUDGET_MS }).toEqual({ overBudget: false });
  }, 60_000);
});

describe("wiring Claude Code creates ~/.claude.json when it does not exist", () => {
  it("writes the file rather than leaving the user a snippet", () => {
    const cfgPath = clientConfigPath("claude-code");
    expect(existsSync(cfgPath)).toBe(false);

    const claudeCode = detectClients().find(c => c.id === "claude-code")!;
    const res = claudeCode.wire({ FLAIR_AGENT_ID: "bob", FLAIR_URL: "http://127.0.0.1:19926" });

    expect(res.ok).toBe(true);
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(cfg.mcpServers.flair.env.FLAIR_AGENT_ID).toBe("bob");
  });

  it("preserves unrelated keys when the file already exists", () => {
    const cfgPath = clientConfigPath("claude-code");
    writeFileSync(cfgPath, JSON.stringify({ numStartups: 7, mcpServers: { other: { command: "x" } } }));

    const claudeCode = detectClients().find(c => c.id === "claude-code")!;
    expect(claudeCode.wire({ FLAIR_AGENT_ID: "bob", FLAIR_URL: "http://127.0.0.1:19926" }).ok).toBe(true);

    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(cfg.numStartups).toBe(7);
    expect(cfg.mcpServers.other.command).toBe("x");
    expect(cfg.mcpServers.flair.env.FLAIR_AGENT_ID).toBe("bob");
  });
});
