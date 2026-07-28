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

describe("Claude Code detection is by binary on PATH, not by its config (flair#906)", () => {
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

  it("does not detect Claude Code when the binary is absent", () => {
    // Empty-ish PATH: no `claude`, and the npm-global fallback cannot run
    // either, so this exercises the negative case end to end.
    process.env.PATH = isoHome;
    const claudeCode = detectClients().find(c => c.id === "claude-code")!;
    expect(claudeCode.detected).toBe(false);
  });
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
