import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { flairCliVersion, mcpServerSpec } from "../../src/lib/mcp-spec.ts";
import {
  ALL_CLIENTS,
  clientConfigPath,
  piSettingsPath,
  PI_FLAIR_PACKAGE,
} from "../../src/install/clients.ts";

/**
 * flair#1778 slice 2c-i-a2, fix round — the guard now reaches the two arms that
 * bypassed it (review findings F1, F2). Both are driven THROUGH the real
 * writer (`client.wire`) against genuine files, and each case reads its
 * precondition back from disk before the call.
 *
 *   F1  pi's `extensions` → `packages` MOVE (flair#1346). When NO `packages`
 *       entry exists, the moved `npm:` source IS the pin on record, so the
 *       move must go through the same never-lower decision. A hold/refuse
 *       leaves BOTH arrays untouched — the misconfiguration is not "cleaned
 *       up" by dropping a pin the CLI is not allowed to lower.
 *   F2  the ABSENT-entry writes (Codex append, Codex fresh file, pi create)
 *       must consult the decision with an ABSENT entry. On a healthy version
 *       that is still a plain write, pinned UP to the running CLI — the
 *       positive controls below.
 *
 * These run against the REAL running version. The unreadable-version REFUSE
 * rows would need `mock.module`, which is process-global, so they live in
 * test/unit-isolated/ (see the header there).
 */

const RUNNING = flairCliVersion();
const RUNNING_PI_SPEC = `npm:${PI_FLAIR_PACKAGE}@${RUNNING}`;
const AHEAD_PI_SPEC = `npm:${PI_FLAIR_PACKAGE}@9.9.9`;
const BEHIND_PI_SPEC = `npm:${PI_FLAIR_PACKAGE}@0.0.1`;
const RANGE_PI_SPEC = `npm:${PI_FLAIR_PACKAGE}@^0.55.0`;
const BARE_PI_SPEC = `npm:${PI_FLAIR_PACKAGE}`;

const ENV = { FLAIR_AGENT_ID: "pinbot", FLAIR_URL: "http://127.0.0.1:19926" };

const piClient = ALL_CLIENTS.find((c) => c.id === "pi")!;
const codexClient = ALL_CLIENTS.find((c) => c.id === "codex")!;

let isoHome: string;
let prevHome: string | undefined;
let prevPiDir: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-pin-move-absent-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
  prevPiDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  if (prevPiDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiDir;
  else delete process.env.PI_CODING_AGENT_DIR;
  rmSync(isoHome, { recursive: true, force: true });
});

/** Write a pi settings.json with `extensions` (and optionally `packages`). */
function writePiSettings(config: unknown): string {
  const path = piSettingsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

/** The raw `extensions` array of the pi settings file on disk. */
function readPiExtensions(path: string): unknown[] {
  return JSON.parse(readFileSync(path, "utf-8")).extensions ?? [];
}

/** The raw `packages` array of the pi settings file on disk. */
function readPiPackages(path: string): unknown[] {
  return JSON.parse(readFileSync(path, "utf-8")).packages ?? [];
}

// ── F1: the #1346 move honours the guard when no packages entry exists ───────

describe("F1 — the extensions→packages move is guarded (no packages entry)", () => {
  // The shape the finding names: a hand-pinned npm: source under `extensions`
  // and an EMPTY (but present) `packages` array — the #1346 misplacement with
  // nothing to fall back on.

  it("(a) moved source AHEAD (@9.9.9) → HELD, bytes byte-identical, extension kept", () => {
    const path = writePiSettings({ extensions: [AHEAD_PI_SPEC], packages: [] });
    // Precondition, read back from disk — a genuine fixture, not a constructor.
    expect(readPiExtensions(path)).toContain(AHEAD_PI_SPEC);
    const before = readFileSync(path, "utf-8");

    const res = piClient.wire(ENV);

    expect(res.ok).toBe(true);
    expect(res.message).toContain("holding");
    expect(res.message).toContain("9.9.9");
    const after = readFileSync(path, "utf-8");
    expect(after).toBe(before); // nothing dropped, nothing written
    expect(readPiExtensions(path)).toContain(AHEAD_PI_SPEC);
    expect(readPiPackages(path)).toEqual([]);
  });

  it("(b) moved source range (^0.55.0) → HELD, bytes byte-identical", () => {
    const path = writePiSettings({ extensions: [RANGE_PI_SPEC], packages: [] });
    expect(readPiExtensions(path)).toContain(RANGE_PI_SPEC);
    const before = readFileSync(path, "utf-8");

    const res = piClient.wire(ENV);

    expect(res.message).toContain("holding");
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(readPiExtensions(path)).toContain(RANGE_PI_SPEC);
  });

  it("(c) moved source BEHIND (@0.0.1) → MOVED and re-pinned UP (positive control)", () => {
    const path = writePiSettings({ extensions: [BEHIND_PI_SPEC], packages: [] });
    expect(readPiExtensions(path)).toContain(BEHIND_PI_SPEC);

    const res = piClient.wire(ENV);

    expect(res.ok).toBe(true);
    expect(res.message).toContain("moved");
    expect(readPiExtensions(path)).not.toContain(BEHIND_PI_SPEC); // moved out
    expect(readPiPackages(path)).toContain(RUNNING_PI_SPEC); // re-pinned up
  });

  it("(d) moved source unpinned (bare npm: source) → MOVED, pinned UP (positive control)", () => {
    const path = writePiSettings({ extensions: [BARE_PI_SPEC], packages: [] });
    expect(readPiExtensions(path)).toContain(BARE_PI_SPEC);

    const res = piClient.wire(ENV);

    expect(res.message).toContain("moved");
    expect(readPiExtensions(path)).not.toContain(BARE_PI_SPEC);
    expect(readPiPackages(path)).toContain(RUNNING_PI_SPEC);
  });

  it("several moved sources: the HIGHEST one governs — a mixed set with an AHEAD source HELDs", () => {
    const path = writePiSettings({ extensions: [BEHIND_PI_SPEC, AHEAD_PI_SPEC], packages: [] });
    expect(readPiExtensions(path)).toEqual([BEHIND_PI_SPEC, AHEAD_PI_SPEC]);
    const before = readFileSync(path, "utf-8");

    const res = piClient.wire(ENV);

    expect(res.message).toContain("holding");
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(readPiExtensions(path)).toEqual([BEHIND_PI_SPEC, AHEAD_PI_SPEC]);
  });

  it("several moved sources: one non-comparable (range) holds even beside a BEHIND one", () => {
    const path = writePiSettings({ extensions: [BEHIND_PI_SPEC, RANGE_PI_SPEC], packages: [] });
    const before = readFileSync(path, "utf-8");

    const res = piClient.wire(ENV);

    expect(res.message).toContain("holding");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("an all-BEHIND mixed set still moves, re-pinned up to the single running pin", () => {
    const path = writePiSettings({
      extensions: [BEHIND_PI_SPEC, `npm:${PI_FLAIR_PACKAGE}@0.0.2`],
      packages: [],
    });

    const res = piClient.wire(ENV);

    expect(res.message).toContain("moved");
    expect(readPiExtensions(path)).toEqual([]);
    expect(readPiPackages(path)).toEqual([RUNNING_PI_SPEC]);
  });
});

// ── F2: absent-entry writes still go through the decision (positive controls) ─

describe("F2 — absent-entry writes consult the decision and stay plain writes (healthy version)", () => {
  const codexPath = () => clientConfigPath("codex");

  it("codex: no config file → created, flair section pinned to the running CLI", () => {
    expect(existsSync(codexPath())).toBe(false);

    const res = codexClient.wire({ ...ENV, FLAIR_CLIENT: "codex" });

    expect(res.ok).toBe(true);
    expect(res.message).toContain("wired");
    const raw = readFileSync(codexPath(), "utf-8");
    expect(raw).toContain("[mcp_servers.flair]");
    expect(raw).toContain(mcpServerSpec());
  });

  it("codex: file exists WITHOUT a flair section → appended, prefix preserved", () => {
    mkdirSync(join(codexPath(), ".."), { recursive: true });
    writeFileSync(codexPath(), `# Codex config\nlog_level = "info"\n`);

    const res = codexClient.wire({ ...ENV, FLAIR_CLIENT: "codex" });

    expect(res.ok).toBe(true);
    expect(res.message).toContain("wired");
    const raw = readFileSync(codexPath(), "utf-8");
    expect(raw).toContain("# Codex config");
    expect(raw).toContain('log_level = "info"');
    expect(raw).toContain(mcpServerSpec());
  });

  it("pi: no settings file → created, packages pinned to the running CLI", () => {
    const path = piSettingsPath();
    expect(existsSync(path)).toBe(false);

    const res = piClient.wire(ENV);

    expect(res.ok).toBe(true);
    expect(res.message).toContain("wired");
    expect(readPiPackages(path)).toEqual([RUNNING_PI_SPEC]);
  });

  it("pi: settings exist with unrelated keys, no packages/extensions entry → packages pinned", () => {
    const path = writePiSettings({ theme: "dark" });

    const res = piClient.wire(ENV);

    expect(res.ok).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8")).theme).toBe("dark");
    expect(readPiPackages(path)).toEqual([RUNNING_PI_SPEC]);
  });
});
