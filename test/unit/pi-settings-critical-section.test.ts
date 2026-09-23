/**
 * pi-settings-critical-section.test.ts — flair#1778 slice 2c-i-d3, fixtures
 * P2 (boundary) and P4 (bytes + mode).
 *
 * Every writer of pi's settings.json is on the shared critical section, and
 * after this slice clients.ts contains NO raw writeFileSync at all (the client
 * config migration is complete). P4 pins the bytes and the created-file mode.
 *
 * ISOLATION (the d2 lesson): pi's config dir comes from PI_CODING_AGENT_DIR as
 * well as HOME, so every fixture points BOTH into a temp dir and asserts the
 * RESOLVED settings path lies inside it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PI_FLAIR_PACKAGE, piSettingsPath, wirePi, unwirePi } from "../../src/install/clients.ts";
import { flairCliVersion } from "../../src/lib/mcp-spec.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsSrc = readFileSync(join(repoRoot, "src", "install", "clients.ts"), "utf-8");
const ownedPinsSrc = readFileSync(join(repoRoot, "src", "lib", "owned-pins.ts"), "utf-8");

const ENV = { FLAIR_AGENT_ID: "pibot", FLAIR_URL: "http://127.0.0.1:19926", FLAIR_CLIENT: "pi" };
const SPEC = `npm:${PI_FLAIR_PACKAGE}@${flairCliVersion()}`;
const STALE = `npm:${PI_FLAIR_PACKAGE}@0.0.1`;

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`no function ${name}`);
  const end = src.indexOf("\n}", start);
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
let pcd: string;
let prevHome: string | undefined;
let prevPcd: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cid3-home-"));
  pcd = join(home, "pcd");
  mkdirSync(pcd, { recursive: true });
  prevHome = process.env.HOME;
  prevPcd = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = pcd;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
  if (prevPcd !== undefined) process.env.PI_CODING_AGENT_DIR = prevPcd; else delete process.env.PI_CODING_AGENT_DIR;
  rmSync(home, { recursive: true, force: true });
});

const cfgPath = () => join(pcd, "settings.json");
const bakPath = () => `${cfgPath()}.bak`;
function assertIsolated() {
  expect(piSettingsPath()).toBe(join(pcd, "settings.json"));
  expect(piSettingsPath().startsWith(pcd + "/")).toBe(true);
}
function seed(content: string): void { writeFileSync(cfgPath(), content, "utf-8"); }

describe("P2 — the pi writers are on the critical section; clients.ts has NO raw writer left", () => {
  it("_wirePi and _unwirePi each call the shared critical section", () => {
    expect(functionBody(clientsSrc, "_wirePi")).toContain("withConfigCriticalSection(");
    expect(functionBody(clientsSrc, "_unwirePi")).toContain("withConfigCriticalSection(");
  });

  it("clients.ts contains NO raw writeFileSync at all — the registry list is EMPTY", () => {
    assertIsolated();
    expect(rawWriteSites(clientsSrc)).toEqual([]);
  });

  it("the pi pin refresh is NOT reached by upgrade/doctor (owned-pins filters kind === 'mcp-client')", () => {
    assertIsolated();
    // owned-pins only refreshes MCP-client targets; pi (a native extension) is
    // never one, so a stale pi-flair pin is not touched by the upgrade/doctor
    // pin refresh. A source pin (the filter) + a behavioural check.
    expect(ownedPinsSrc).toContain('kind === "mcp-client"');
    expect(ownedPinsSrc).toContain('OwnedPinKind = "mcp-client" | "session-start-hook"');
    seed(JSON.stringify({ packages: [STALE], extra: "keep" }, null, 2) + "\n");
    const before = readFileSync(cfgPath(), "utf-8");
    // There is no OwnedPinTarget for pi at all — the refresh has nothing to act on.
    const stale = ownedPinsSrc.match(/pi-flair|piSettingsPath|\.pi\b/g) ?? [];
    expect(stale, "owned-pins must not reference pi at all").toEqual([]);
    expect(readFileSync(cfgPath(), "utf-8")).toBe(before);
  });
});

describe("P4 — bytes + mode", () => {
  it("CREATE (absent) writes the pinned packages entry, 0600, no backup", () => {
    assertIsolated();
    const r = wirePi(ENV);
    expect(r.ok).toBe(true);
    const expected = JSON.stringify({ packages: [SPEC] }, null, 2) + "\n";
    expect(readFileSync(cfgPath(), "utf-8")).toBe(expected);
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
    expect(existsSync(bakPath())).toBe(false); // no backup on first create
  });

  it("re-wire against a STALE pin refreshes to today's exact bytes", () => {
    assertIsolated();
    seed(JSON.stringify({ packages: [STALE], keep: { a: 1 } }, null, 2) + "\n");
    const r = wirePi(ENV);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("refreshed pin in");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(JSON.stringify({ packages: [SPEC], keep: { a: 1 } }, null, 2) + "\n");
    // backup of the IN-LOCK (pre-write) bytes, 0600
    expect(statSync(bakPath()).mode & 0o777).toBe(0o600);
  });

  it("already-wired is a byte no-op (with a backup)", () => {
    assertIsolated();
    seed(JSON.stringify({ packages: [SPEC] }, null, 2) + "\n");
    const before = readFileSync(cfgPath(), "utf-8");
    const r = wirePi(ENV);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("already wired");
    expect(readFileSync(cfgPath(), "utf-8")).toBe(before);
    expect(existsSync(bakPath())).toBe(true);
  });

  it("unwire produces today's exact bytes", () => {
    assertIsolated();
    seed(JSON.stringify({ packages: [SPEC], other: "x" }, null, 2) + "\n");
    const r = unwirePi();
    expect(r).toEqual({ ok: true, removed: true, message: expect.stringContaining("pi: unwired") });
    expect(readFileSync(cfgPath(), "utf-8")).toBe(JSON.stringify({ packages: [], other: "x" }, null, 2) + "\n");
  });

  it("message parity for absent / no-extension unwire", () => {
    assertIsolated();
    expect(unwirePi().message).toContain("pi: no config at");
    seed(JSON.stringify({ other: 1 }, null, 2) + "\n");
    expect(unwirePi().message).toContain("pi: no Flair extension in");
  });
});
