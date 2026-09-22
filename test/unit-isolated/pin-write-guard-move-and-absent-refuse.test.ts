import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * flair#1778 slice 2c-i-a2, fix round — the REFUSE row on the arms that
 * bypassed it (review findings F1(e), F2, and the N3 message artifact).
 *
 * Every case runs with the RUNNING VERSION UNREADABLE, asserted THROUGH the
 * real writers against genuine files. On main each of these writes the
 * UNPINNED spec (or, for N3, reports a false "already wired") — the exact
 * fallback the fragment says is refused.
 *
 * `mock.module` is process-global (the root unit step runs every test/unit
 * file in ONE bun process), so this file lives in test/unit-isolated/, which
 * runs one file per process. `flairCliVersion` is mocked before the writers
 * are imported.
 */
mock.module("../../src/lib/mcp-spec.ts", () => ({
  FLAIR_MCP_PACKAGE: "@tpsdev-ai/flair-mcp",
  FLAIR_PACKAGE: "@tpsdev-ai/flair",
  UNKNOWN_VERSION: "unknown",
  resolveFlairCliVersion: () => "unknown",
  flairCliVersion: () => "unknown",
  clearFlairCliVersionCache: () => {},
  isResolvedVersion: (v: string) => !!v && v !== "unknown",
  mcpServerSpec: (v: string = "unknown") =>
    v && v !== "unknown" ? `@tpsdev-ai/flair-mcp@${v}` : "@tpsdev-ai/flair-mcp",
  unpinnedSpecWarning: () => "this CLI cannot read its own version",
}));

const { ALL_CLIENTS, clientConfigPath, piSettingsPath, PI_FLAIR_PACKAGE } = await import(
  "../../src/install/clients.ts"
);
const { FLAIR_MCP_PACKAGE } = await import("../../src/lib/mcp-spec.ts");

const ENV = { FLAIR_AGENT_ID: "pinbot", FLAIR_URL: "http://127.0.0.1:19926" };
const AHEAD_PI_SPEC = `npm:${PI_FLAIR_PACKAGE}@9.9.9`;

const piClient = ALL_CLIENTS.find((c) => c.id === "pi")!;
const codexClient = ALL_CLIENTS.find((c) => c.id === "codex")!;

let isoHome: string;
let prevHome: string | undefined;
let prevPiDir: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-pin-move-refuse-"));
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

function writePiSettings(config: unknown): string {
  const path = piSettingsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  return path;
}

function writeCodex(raw: string): string {
  const path = clientConfigPath("codex");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, raw);
  return path;
}

describe("F1(e) — a moved source with an unreadable version REFUSES, bytes identical", () => {
  it("pi: the misplaced pin is NOT moved, and no unpinned packages entry is written", () => {
    const path = writePiSettings({ extensions: [AHEAD_PI_SPEC], packages: [] });
    const before = readFileSync(path, "utf-8");

    const res = piClient.wire(ENV);

    expect(res.message).toContain("REFUSING");
    expect(readFileSync(path, "utf-8")).toBe(before); // extension kept, nothing written
    expect(JSON.parse(readFileSync(path, "utf-8")).extensions).toContain(AHEAD_PI_SPEC);
    expect(JSON.parse(readFileSync(path, "utf-8")).packages).toEqual([]);
  });
});

describe("F2 — absent-entry writes REFUSE on an unreadable version", () => {
  it("codex: file exists with no flair section → refuses, bytes identical", () => {
    const path = writeCodex(`# Codex config\nlog_level = "info"\n`);
    const before = readFileSync(path, "utf-8");

    const res = codexClient.wire({ ...ENV, FLAIR_CLIENT: "codex" });

    expect(res.message).toContain("REFUSING");
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(readFileSync(path, "utf-8")).not.toContain(FLAIR_MCP_PACKAGE);
  });

  it("codex: no config file → refuses, nothing created", () => {
    const path = clientConfigPath("codex");
    expect(existsSync(path)).toBe(false);

    const res = codexClient.wire({ ...ENV, FLAIR_CLIENT: "codex" });

    expect(res.message).toContain("REFUSING");
    expect(existsSync(path)).toBe(false);
  });

  it("pi: no settings file → refuses, nothing created", () => {
    const path = piSettingsPath();
    expect(existsSync(path)).toBe(false);

    const res = piClient.wire(ENV);

    expect(res.message).toContain("REFUSING");
    expect(existsSync(path)).toBe(false);
  });

  it("pi: settings exist with no packages entry → refuses, bytes identical", () => {
    const path = writePiSettings({ theme: "dark" });
    const before = readFileSync(path, "utf-8");

    const res = piClient.wire(ENV);

    expect(res.message).toContain("REFUSING");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});

describe("N3 — a PINNED Codex section is not reported as 'already wired' when the version is unreadable", () => {
  it("goes through the decision and prints the refuse line", () => {
    // A pinned section. The old code's section scan compared its text against
    // the (unreadable → UNPINNED) mcpServerSpec(), and a pinned spec CONTAINS
    // the bare package substring — so it matched and said "already wired".
    const pinned = [
      `[mcp_servers.flair]`,
      `command = "npx"`,
      `args = ["-y", "${FLAIR_MCP_PACKAGE}@0.55.1"]`,
      ``,
      `[mcp_servers.flair.env]`,
      `FLAIR_AGENT_ID = "${ENV.FLAIR_AGENT_ID}"`,
      `FLAIR_URL = "${ENV.FLAIR_URL}"`,
      ``,
    ].join("\n");
    const path = writeCodex(pinned);
    const before = readFileSync(path, "utf-8");

    const res = codexClient.wire({ ...ENV, FLAIR_CLIENT: "codex" });

    expect(res.message).toContain("REFUSING");
    expect(res.message).not.toContain("already wired");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});
