import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mcpServerSpec, flairCliVersion, FLAIR_MCP_PACKAGE } from "../../src/lib/mcp-spec.ts";
import { decidePinWrite } from "../../src/lib/pin-write-guard.ts";
import {
  ALL_CLIENTS,
  clientConfigPath,
  piSettingsPath,
  type ClientId,
  type WireEnv,
} from "../../src/install/clients.ts";

/**
 * flair#1778 slice 2c-i-a2 — the DIRECT writers never LOWER a pin.
 *
 * Spec I1: no writer lowers the version of the artifact it writes to unless the
 * user typed that exact lower version. Every fixture here SETS the field to the
 * spec under test and then goes THROUGH the production write path
 * (`client.wire(...)`), asserting the writer's genuine output — a hand-written
 * config is presence, not validity.
 *
 * The decision itself lives in ONE place (`src/lib/pin-write-guard.ts`, reusing
 * `pinWriteWouldLowerOrIsUnknown` / `comparePinVersions`); the matrix block
 * below pins that, and the writer blocks pin that each writer CONSULTS it.
 */

const PKG_VERSION: string = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8"),
).version;

const CURRENT_SPEC = mcpServerSpec(); // @tpsdev-ai/flair-mcp@<running>
const AHEAD_SPEC = `${FLAIR_MCP_PACKAGE}@9.9.9`;
const BEHIND_SPEC = `${FLAIR_MCP_PACKAGE}@0.0.1`;
const UNPINNED_SPEC = FLAIR_MCP_PACKAGE;

const ENV: WireEnv = { FLAIR_AGENT_ID: "pinbot", FLAIR_URL: "http://127.0.0.1:19926" };

let isoHome: string;
let prevHome: string | undefined;
let prevPiDir: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-pin-guard-"));
  prevHome = process.env.HOME;
  prevPiDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = isoHome;
  // Point pi's config dir at the isolated home too. The test harness sets
  // PI_CODING_AGENT_DIR to its shared sandbox (flair#1853); leaving it there
  // would write settings.json into a directory sibling cases read.
  process.env.PI_CODING_AGENT_DIR = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  if (prevPiDir !== undefined) process.env.PI_CODING_AGENT_DIR = prevPiDir;
  else delete process.env.PI_CODING_AGENT_DIR;
  rmSync(isoHome, { recursive: true, force: true });
});

// ── The matrix, at the ONE decision ─────────────────────────────────────────

describe("decidePinWrite — the provision-wiring matrix", () => {
  const RUN = flairCliVersion();
  const d = (existingText: string | null, runningVersion: string = RUN) =>
    decidePinWrite({ pkg: FLAIR_MCP_PACKAGE, entry: "the entry", existingText, runningVersion });

  it("AHEAD of the running CLI → HOLD (named: entry, pinned, running)", () => {
    const r = d(`npx -y ${FLAIR_MCP_PACKAGE}@9.9.9`);
    expect(r.action).toBe("hold");
    expect(r.line).toContain("9.9.9");
    expect(r.line).toContain(RUN);
  });

  it("BEHIND → write, repin UP (positive control)", () => {
    const r = d(`npx -y ${FLAIR_MCP_PACKAGE}@0.0.1`);
    expect(r.action).toBe("write");
    expect(r.pin).toBe(RUN);
  });

  it("equal → write (shape repair, same pin)", () => {
    expect(d(`npx -y ${FLAIR_MCP_PACKAGE}@${RUN}`).action).toBe("write");
  });

  it("unpinned → write, pin UP to the running CLI", () => {
    const r = d(`npx -y ${FLAIR_MCP_PACKAGE}`);
    expect(r.action).toBe("write");
    expect(r.pin).toBe(RUN);
  });

  it("absent → write (provision)", () => {
    expect(d(null).action).toBe("write");
  });

  for (const spec of [
    "^0.55.0",
    "latest",
    "beta",
    "v0.55.0",
    "1.2.3.4",
    "file:../x",
    "link:../x",
    "git:https://example.invalid/x.git",
    "github:o/r",
  ]) {
    it(`range/tag/unsupported/malformed @${spec} → HOLD, and the token is PRESERVED (not normalised)`, () => {
      const r = d(`npx -y ${FLAIR_MCP_PACKAGE}@${spec}`);
      expect(r.action).toBe("hold");
      expect(r.line).toContain(spec);
    });
  }

  it("running CLI version unreadable → REFUSE, nothing written", () => {
    const r = d(`npx -y ${FLAIR_MCP_PACKAGE}@0.1.0`, "unknown");
    expect(r.action).toBe("refuse");
    expect(r.line).toContain("REFUSING");
    expect(r.line).toContain("unknown");
  });

  it("an unreadable running version refuses even when the entry is absent", () => {
    expect(d(null, "unknown").action).toBe("refuse");
  });
});

// ── clients.ts writers ──────────────────────────────────────────────────────

/** Write a JSON MCP config whose flair args carry `spec`; returns its path. */
function writeJsonConfig(clientId: ClientId, spec: string, extra: Record<string, unknown> = {}) {
  const path = clientConfigPath(clientId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    ...extra,
    mcpServers: {
      flair: {
        command: "npx",
        args: ["-y", spec],
        env: { FLAIR_AGENT_ID: ENV.FLAIR_AGENT_ID, FLAIR_URL: ENV.FLAIR_URL },
      },
    },
  }, null, 2) + "\n");
  return path;
}

function writeCodexConfig(spec: string) {
  const path = clientConfigPath("codex");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, [
    `[mcp_servers.flair]`,
    `command = "npx"`,
    `args = ["-y", "${spec}"]`,
    ``,
    `[mcp_servers.flair.env]`,
    `FLAIR_AGENT_ID = "${ENV.FLAIR_AGENT_ID}"`,
    `FLAIR_URL = "${ENV.FLAIR_URL}"`,
  ].join("\n") + "\n");
  return path;
}

function writePiSettings(source: string) {
  const path = piSettingsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ packages: [source] }, null, 2) + "\n");
  return path;
}

function readCodexPin(): string | null {
  const raw = readFileSync(clientConfigPath("codex"), "utf-8");
  const m = raw.match(/args = \["-y", "([^"]+)"\]/);
  return m ? m[1]! : null;
}

function readPiSource(): string | null {
  const cfg = JSON.parse(readFileSync(piSettingsPath(), "utf-8"));
  return Array.isArray(cfg.packages) ? (cfg.packages[0] ?? null) : null;
}

const jsonClients = ALL_CLIENTS.filter((c) => c.id !== "codex" && c.kind === "mcp");

describe("clients.ts JSON writers — the pin is never lowered", () => {
  for (const client of jsonClients) {
    const wire = () => client.wire({ ...ENV, FLAIR_CLIENT: client.id });

    it(`${client.label}: an AHEAD pin → bytes UNCHANGED + a held line`, () => {
      const path = writeJsonConfig(client.id as ClientId, AHEAD_SPEC);
      // (10) the fixture genuinely set the field:
      expect(readFileSync(path, "utf-8")).toContain(AHEAD_SPEC);
      const before = readFileSync(path, "utf-8");

      const res = wire();

      expect(res.ok).toBe(true);
      expect(res.message).toContain("holding");
      expect(res.message).toContain("9.9.9");
      expect(readFileSync(path, "utf-8")).toBe(before); // bytes UNCHANGED
    });

    it(`${client.label}: @^0.55.0 and @latest → held, bytes preserved`, () => {
      for (const spec of [`${FLAIR_MCP_PACKAGE}@^0.55.0`, `${FLAIR_MCP_PACKAGE}@latest`]) {
        const path = writeJsonConfig(client.id as ClientId, spec);
        const before = readFileSync(path, "utf-8");
        const res = wire();
        expect(res.message).toContain("holding");
        expect(readFileSync(path, "utf-8")).toBe(before);
      }
    });

    it(`${client.label}: a file:/link:/git:/github: source → held, bytes preserved`, () => {
      for (const src of ["file:../x", "link:../x", "git:https://example.invalid/x.git", "github:o/r"]) {
        const path = writeJsonConfig(client.id as ClientId, `${FLAIR_MCP_PACKAGE}@${src}`);
        const before = readFileSync(path, "utf-8");
        const res = wire();
        expect(res.message).toContain("holding");
        expect(readFileSync(path, "utf-8")).toBe(before);
      }
    });

    it(`${client.label}: @v0.55.0 and @1.2.3.4 → held, NOT normalised`, () => {
      for (const spec of [`${FLAIR_MCP_PACKAGE}@v0.55.0`, `${FLAIR_MCP_PACKAGE}@1.2.3.4`]) {
        const path = writeJsonConfig(client.id as ClientId, spec);
        const before = readFileSync(path, "utf-8");
        const res = wire();
        expect(res.message).toContain("holding");
        expect(readFileSync(path, "utf-8")).toBe(before);
      }
    });

    it(`${client.label}: unpinned → pinned UP to the running CLI`, () => {
      writeJsonConfig(client.id as ClientId, UNPINNED_SPEC);
      const res = wire();
      expect(res.ok).toBe(true);
      expect(readFileSync(clientConfigPath(client.id as ClientId), "utf-8")).toContain(CURRENT_SPEC);
    });

    it(`${client.label}: BEHIND + newer running CLI → repin UP (positive control)`, () => {
      writeJsonConfig(client.id as ClientId, BEHIND_SPEC);
      expect(readFileSync(clientConfigPath(client.id as ClientId), "utf-8")).toContain(BEHIND_SPEC);
      const res = wire();
      expect(res.ok).toBe(true);
      expect(res.message).toContain("refreshed pin");
      expect(readFileSync(clientConfigPath(client.id as ClientId), "utf-8")).toContain(CURRENT_SPEC);
    });
  }
});

describe("clients.ts Codex TOML writer — the pin is never lowered", () => {
  const codex = ALL_CLIENTS.find((c) => c.id === "codex")!;
  const wire = () => codex.wire({ ...ENV, FLAIR_CLIENT: "codex" });

  it("AHEAD → bytes UNCHANGED + a held line", () => {
    const path = writeCodexConfig(AHEAD_SPEC);
    expect(readCodexPin()).toBe(AHEAD_SPEC); // (10) genuine fixture
    const before = readFileSync(path, "utf-8");
    const res = wire();
    expect(res.message).toContain("holding");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("@^0.55.0 / @latest / file: / @v0.55.0 / @1.2.3.4 → held, bytes preserved", () => {
    for (const spec of [
      `${FLAIR_MCP_PACKAGE}@^0.55.0`,
      `${FLAIR_MCP_PACKAGE}@latest`,
      `${FLAIR_MCP_PACKAGE}@file:../x`,
      `${FLAIR_MCP_PACKAGE}@v0.55.0`,
      `${FLAIR_MCP_PACKAGE}@1.2.3.4`,
    ]) {
      const path = writeCodexConfig(spec);
      const before = readFileSync(path, "utf-8");
      const res = wire();
      expect(res.message).toContain("holding");
      expect(readFileSync(path, "utf-8")).toBe(before);
    }
  });

  it("unpinned → pinned UP; BEHIND → repin UP", () => {
    writeCodexConfig(UNPINNED_SPEC);
    wire();
    expect(readCodexPin()).toBe(CURRENT_SPEC);

    writeCodexConfig(BEHIND_SPEC);
    const res = wire();
    expect(res.message).toContain("refreshed pin");
    expect(readCodexPin()).toBe(CURRENT_SPEC);
  });
});

describe("clients.ts pi writer — the pin is never lowered", () => {
  it("AHEAD → bytes UNCHANGED + a held line", () => {
    const path = writePiSettings(`npm:${FLAIR_MCP_PACKAGE.replace("flair-mcp", "pi-flair")}@9.9.9`);
    const before = readFileSync(path, "utf-8");
    const res = ALL_CLIENTS.find((c) => c.id === "pi")!.wire({ ...ENV });
    expect(res.message).toContain("holding");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("range / tag / unsupported → held, bytes preserved", () => {
    for (const tok of ["^0.55.0", "latest", "file:../x"]) {
      const path = writePiSettings(`npm:@tpsdev-ai/pi-flair@${tok}`);
      const before = readFileSync(path, "utf-8");
      const res = ALL_CLIENTS.find((c) => c.id === "pi")!.wire({ ...ENV });
      expect(res.message).toContain("holding");
      expect(readFileSync(path, "utf-8")).toBe(before);
    }
  });

  it("unpinned → pinned UP; BEHIND → repin UP", () => {
    writePiSettings("npm:@tpsdev-ai/pi-flair");
    ALL_CLIENTS.find((c) => c.id === "pi")!.wire({ ...ENV });
    expect(readPiSource()).toContain(`@${PKG_VERSION}`);

    writePiSettings("npm:@tpsdev-ai/pi-flair@0.0.1");
    ALL_CLIENTS.find((c) => c.id === "pi")!.wire({ ...ENV });
    expect(readPiSource()).toContain(`@${PKG_VERSION}`);
  });
});
