/**
 * codex-toml-critical-section.test.ts — flair#1778 slice 2c-i-d2, fixtures T3
 * (boundary) and T5 (byte goldens + backup semantics).
 *
 * Every writer of Codex's ~/.codex/config.toml must go through ONE critical
 * section. T3 pins that boundary at the source; T5 pins that the bytes written
 * are EXACTLY the ones the pure TOML helpers produced before the migration
 * (append / replace / create / remove), plus the `.bak` semantics: a 0600
 * sibling on every call where the file EXISTS (write, no-op and held
 * included), and NONE when the file is first created.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wireCodex, unwireCodex, tomlSnippet, appendCodexFlairBlock, removeCodexFlairBlock } from "../../src/install/clients.ts";
import { FLAIR_MCP_PACKAGE, mcpServerSpec } from "../../src/lib/mcp-spec.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsSrc = readFileSync(join(repoRoot, "src", "install", "clients.ts"), "utf-8");
const hookInstallSrc = readFileSync(join(repoRoot, "src", "hook-install.ts"), "utf-8");

const ENV = { FLAIR_AGENT_ID: "codexbot", FLAIR_URL: "http://127.0.0.1:19926", FLAIR_CLIENT: "codex" };
const SPEC = mcpServerSpec();

/** An INDEPENDENT literal rendering of the Flair TOML block (golden source). */
function goldenBlock(env: typeof ENV): string {
  return [
    `[mcp_servers.flair]`,
    `command = "npx"`,
    `args = ["-y", "${SPEC}"]`,
    ``,
    `[mcp_servers.flair.env]`,
    `FLAIR_AGENT_ID = "${env.FLAIR_AGENT_ID}"`,
    `FLAIR_URL = "${env.FLAIR_URL}"`,
    `FLAIR_CLIENT = "${env.FLAIR_CLIENT}"`,
  ].join("\n");
}

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`no function ${name}`);
  // The function's body closes with a `}` at column 0 (this file's style).
  const end = src.indexOf("\n}", start);
  if (end === -1) throw new Error(`no end for ${name}`);
  return src.slice(start, end + 2);
}

function rawWriteSites(src: string): string[] {
  const out: string[] = [];
  let current = "<top level>";
  for (const line of src.split("\n")) {
    const fn = line.match(/^(?:export )?(?:async )?function (\w+)\s*\(/);
    if (fn) current = fn[1];
    if (line.includes("writeFileSync(")) out.push(current);
  }
  return out;
}

let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cid2-home-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(home, { recursive: true, force: true });
});

const cfgPath = () => join(home, ".codex", "config.toml");
const bakPath = () => `${cfgPath()}.bak`;
function seed(content: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(cfgPath(), content, "utf-8");
}
const OTHER = `[other]\nk = "v"\n`;
const STALE_SECTION = `[mcp_servers.flair]\ncommand = "npx"\nargs = ["-y", "${FLAIR_MCP_PACKAGE}@0.0.1"]\n\n[mcp_servers.flair.env]\nFLAIR_AGENT_ID = "codexbot"\nFLAIR_URL = "http://127.0.0.1:19926"\n`;

describe("T3 — the Codex writers are on the critical section; the rest are Codex/pi-free", () => {
  it("_wireCodex and _unwireCodex each call the shared critical section", () => {
    expect(functionBody(clientsSrc, "_wireCodex")).toContain("withConfigCriticalSection(");
    expect(functionBody(clientsSrc, "_unwireCodex")).toContain("withConfigCriticalSection(");
  });

  it("no raw writeFileSync remains in the Codex writers — config.toml is never written in place", () => {
    const sites = rawWriteSites(clientsSrc);
    expect(sites).not.toContain("_wireCodex");
    expect(sites).not.toContain("_unwireCodex");
    // This base includes #1829 (the JSON client writers moved onto the critical
    // section), so the ONLY raw writeFileSync left in clients.ts are the pi
    // writers (2c-i-d3), pinned BY NAME. A brand-new raw site is a failure.
    expect([...sites].sort()).toEqual(["_unwirePi", "_wirePi"]);
  });

  it("hook-install.ts's readCodexConfigToml stays READ-ONLY (no writeFileSync anywhere in the module)", () => {
    expect(hookInstallSrc).not.toContain("writeFileSync");
    expect(hookInstallSrc).toContain("function readCodexConfigToml(");
  });
});

describe("T5 — byte goldens (the helpers' output, unchanged)", () => {
  it("CREATE (file absent) writes exactly the snippet + newline", () => {
    const r = wireCodex(ENV);
    expect(r.ok).toBe(true);
    expect(r.message).toBe("Codex: wired ~/.codex/config.toml (restart Codex to pick it up)");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(goldenBlock(ENV) + "\n");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(tomlSnippet(ENV) + "\n");
    expect(existsSync(bakPath())).toBe(false); // no backup on first create
    // K1 (declared behaviour change): a CREATED config.toml lands 0600 (the
    // primitive's staging mode), where the old raw create arm got the umask
    // default (~0644). Matches the approved 2c-i-b "new file is 0600" rule.
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
  });

  it("APPEND (file exists, no section) preserves the file and appends the block", () => {
    seed(OTHER);
    const r = wireCodex(ENV);
    expect(r.ok).toBe(true);
    const expected = OTHER + "\n" + goldenBlock(ENV) + "\n";
    expect(readFileSync(cfgPath(), "utf-8")).toBe(expected);
    expect(readFileSync(cfgPath(), "utf-8")).toBe(appendCodexFlairBlock(OTHER, ENV));
    // backup of the IN-LOCK (pre-write) bytes
    expect(readFileSync(bakPath(), "utf-8")).toBe(OTHER);
    expect(statSync(bakPath()).mode & 0o777).toBe(0o600);
  });

  it("REPLACE (stale section) swaps the section in place, preserving siblings", () => {
    seed(OTHER + "\n" + STALE_SECTION);
    const r = wireCodex(ENV);
    expect(r.ok).toBe(true);
    expect(r.message).toBe("Codex: refreshed pin in ~/.codex/config.toml (restart Codex to pick it up)");
    const before = OTHER + "\n" + STALE_SECTION;
    const expected = OTHER + "\n" + goldenBlock(ENV) + "\n";
    expect(readFileSync(cfgPath(), "utf-8")).toBe(expected);
    expect(readFileSync(bakPath(), "utf-8")).toBe(before);
  });

  it("ALREADY (current pin) is a no-op on the bytes but takes a backup", () => {
    seed(OTHER + "\n" + goldenBlock(ENV) + "\n");
    const before = readFileSync(cfgPath(), "utf-8");
    const r = wireCodex(ENV);
    expect(r.ok).toBe(true);
    expect(r.message).toBe("Codex: already wired in ~/.codex/config.toml");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(before);
    expect(existsSync(bakPath())).toBe(true);
  });

  it("REMOVE (unwire) writes exactly removeCodexFlairBlock's output", () => {
    const before = OTHER + "\n" + goldenBlock(ENV) + "\n";
    seed(before);
    const r = unwireCodex();
    expect(r).toEqual({ ok: true, removed: true, message: "Codex: unwired ~/.codex/config.toml" });
    expect(readFileSync(cfgPath(), "utf-8")).toBe(removeCodexFlairBlock(before));
    expect(readFileSync(bakPath(), "utf-8")).toBe(before);
  });

  it("message parity for the absent / no-section unwire cases", () => {
    expect(unwireCodex().message).toBe("Codex: no config at ~/.codex/config.toml");
    seed(OTHER);
    expect(unwireCodex().message).toBe("Codex: no Flair MCP entry in ~/.codex/config.toml");
  });
});
