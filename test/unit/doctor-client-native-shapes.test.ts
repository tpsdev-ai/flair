import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  readClientMcpBlock,
  effectiveFlairUrl,
  FLAIR_CLIENT_DEFAULT_URL,
} from "../../src/doctor-client.ts";
import {
  ALL_CLIENTS,
  clientConfigPath,
  tomlSnippet,
  wireClaudeCode,
  wireCodex,
  wireGemini,
  wireCursor,
  wireAntigravity,
  type ClientId,
  type WireEnv,
} from "../../src/install/clients.ts";

/**
 * flair#1287 — doctor false-negatived a WORKING setup written by a client's
 * own tooling. Root cause (Kern's ruling on the issue): readJsonFlairBlock
 * demanded BOTH FLAIR_AGENT_ID and FLAIR_URL for `present`, while flair-client
 * treats FLAIR_URL as optional (falls back to its DEFAULT_URL) and the
 * documented `claude mcp add` command sets only FLAIR_AGENT_ID.
 *
 * The fixtures below are the LITERAL client-native config shapes — what each
 * client's own tooling writes today — NOT the output of our wire functions.
 * That distinction is the whole point: the #1287 defect was precisely that
 * the client-written shape and our generated shape drifted apart, and a
 * fixture produced by our own generator can never express that defect class.
 * Each fixture therefore also carries a DRIFT-DETECTION assertion: doctor
 * must accept the fixture AND the fixture must NOT be byte-identical to what
 * our wire function writes. If those ever converge, the fixture has stopped
 * testing anything our generator round-trip doesn't already cover, and must
 * be re-captured from the client's tooling.
 *
 * Fixture provenance (verify before editing any of these):
 *   claude-code — CAPTURED LIVE 2026-08-20 from `claude mcp add flair
 *     --scope user -e FLAIR_AGENT_ID=canary -- npx -y
 *     @tpsdev-ai/flair-mcp@0.46.0` run against an isolated HOME
 *     (machineID/userID anonymized to zeros; every other byte literal,
 *     including the `type: "stdio"` field and the env with ONLY
 *     FLAIR_AGENT_ID — the exact shape the 2026-08-19 canary hit).
 *   gemini — CAPTURED LIVE 2026-08-20 from `gemini mcp add flair npx
 *     --scope user -e FLAIR_AGENT_ID=canary -- -y @tpsdev-ai/flair-mcp@0.46.0`
 *     against an isolated HOME. Byte literal.
 *   codex — derived from openai/codex source (`codex mcp add` serializes env
 *     as a `[mcp_servers.<name>.env]` sub-table with sorted keys:
 *     codex-rs/core/src/config/edit/document_helpers.rs,
 *     serialize_mcp_server_table → table_from_pairs, read 2026-08-20) and
 *     Codex's config docs, which show the same sub-table form. Structure is
 *     source-verified; inter-table whitespace is approximated (the scanner is
 *     line-anchored and whitespace-insensitive). Not captured live: the host
 *     codex install's vendor binary is broken.
 *   cursor — cursor.com/docs/context/mcp "Using mcp.json" (CLI Server -
 *     Node.js example shape, read 2026-08-20), with the flair values our
 *     docs/mcp-clients.md tells users to set (FLAIR_AGENT_ID only).
 *   antigravity — antigravity.google/docs/mcp "standardized format" example
 *     (read 2026-08-20), including a sibling non-flair server entry as their
 *     doc shows; flair entry per our docs (FLAIR_AGENT_ID only).
 */

// ── the literal client-native fixtures ──────────────────────────────────────

const CLAUDE_CODE_NATIVE = `{
  "firstStartTime": "2026-08-20T18:32:54.311Z",
  "machineID": "0000000000000000000000000000000000000000000000000000000000000000",
  "opusProMigrationComplete": true,
  "sonnet1m45MigrationComplete": true,
  "seenNotifications": {},
  "hasResetAutoModeOptInForDefaultOffer": true,
  "migrationVersion": 13,
  "userID": "0000000000000000000000000000000000000000000000000000000000000000",
  "mcpServers": {
    "flair": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@tpsdev-ai/flair-mcp@0.46.0"
      ],
      "env": {
        "FLAIR_AGENT_ID": "canary"
      }
    }
  }
}`;

const CODEX_NATIVE = `[mcp_servers.flair]
command = "npx"
args = ["-y", "@tpsdev-ai/flair-mcp@0.46.0"]

[mcp_servers.flair.env]
FLAIR_AGENT_ID = "canary"
`;

const GEMINI_NATIVE = `{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": [
        "-y",
        "@tpsdev-ai/flair-mcp@0.46.0"
      ],
      "env": {
        "FLAIR_AGENT_ID": "canary"
      }
    }
  }
}`;

const CURSOR_NATIVE = `{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": ["-y", "@tpsdev-ai/flair-mcp@0.46.0"],
      "env": {
        "FLAIR_AGENT_ID": "canary"
      }
    }
  }
}`;

const ANTIGRAVITY_NATIVE = `{
  "mcpServers": {
    "sqlite-explorer": {
      "command": "node",
      "args": ["/usr/local/bin/sqlite-mcp-server.js"],
      "env": {
        "SQLITE_DB_PATH": "/var/data/app.db"
      }
    },
    "flair": {
      "command": "npx",
      "args": ["-y", "@tpsdev-ai/flair-mcp@0.46.0"],
      "env": {
        "FLAIR_AGENT_ID": "canary"
      }
    }
  }
}`;

// pi is in the registry but is NOT an MCP client (kind: "native-extension",
// flair#1342) — it has no mcpServers block for readClientMcpBlock to accept,
// so it has no fixture here BY DESIGN. Its native-shape coverage (settings.json
// `packages`/`extensions`, including the flair#1346 npm:-under-extensions trap)
// lives in test/unit/pi-client.test.ts.
type McpClientId = Exclude<ClientId, "pi">;
const MCP_CLIENTS = ALL_CLIENTS.filter((c) => c.kind === "mcp");

const NATIVE_FIXTURES: Record<McpClientId, string> = {
  "claude-code": CLAUDE_CODE_NATIVE,
  codex: CODEX_NATIVE,
  gemini: GEMINI_NATIVE,
  cursor: CURSOR_NATIVE,
  antigravity: ANTIGRAVITY_NATIVE,
};

const WIRE_FNS: Record<McpClientId, (env: WireEnv) => { ok: boolean; message: string }> = {
  "claude-code": wireClaudeCode,
  codex: wireCodex,
  gemini: wireGemini,
  cursor: wireCursor,
  antigravity: wireAntigravity,
};

// The env our wire functions are fed for the drift comparison. Same agent id
// as the fixtures; a URL because WireEnv requires one (our generator always
// writes FLAIR_URL — one of the very drifts these fixtures exist to pin).
const WIRE_ENV: WireEnv = { FLAIR_AGENT_ID: "canary", FLAIR_URL: "http://127.0.0.1:19926" };

// ── isolation ───────────────────────────────────────────────────────────────

let isoHome: string;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-native-shapes-"));
});

afterEach(() => {
  rmSync(isoHome, { recursive: true, force: true });
});

/** clientConfigPath()/the wire functions resolve HOME from the live env at
 *  call time (see resolveHome in src/install/clients.ts) — same technique as
 *  client-wiring.test.ts, scoped to a callback so no test leaks the override. */
function withHomeEnv<T>(home: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
}

function writeNativeFixture(home: string, clientId: McpClientId): string {
  const path = withHomeEnv(home, () => clientConfigPath(clientId));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, NATIVE_FIXTURES[clientId]);
  return path;
}

/** Run OUR wire function for `clientId` against a fresh HOME and return the
 *  exact file bytes it wrote — the "our generator" side of every drift
 *  assertion. */
function ourWireOutput(clientId: McpClientId): string {
  const wireHome = mkdtempSync(join(tmpdir(), "flair-wire-out-"));
  try {
    return withHomeEnv(wireHome, () => {
      const res = WIRE_FNS[clientId](WIRE_ENV);
      // Positive control: if the wire itself failed, the drift comparison
      // below would be comparing against an error message's absence.
      expect(res.ok).toBe(true);
      return readFileSync(clientConfigPath(clientId), "utf-8");
    });
  } finally {
    rmSync(wireHome, { recursive: true, force: true });
  }
}

// ── the per-client suites ───────────────────────────────────────────────────

describe("doctor recognizes client-NATIVE MCP config shapes (flair#1287)", () => {
  it("carries a client-native fixture for EVERY MCP registry client — a new mcp-kind ALL_CLIENTS entry must add one", () => {
    // Filtered on kind, not on a hardcoded id list: a future MCP client is
    // still forced to add a fixture, while a native-extension client (pi —
    // no mcpServers block exists for it, flair#1342) is excluded by its
    // declared kind rather than by someone remembering to exempt it here.
    expect(Object.keys(NATIVE_FIXTURES).sort()).toEqual(MCP_CLIENTS.map((c) => c.id).sort());
  });

  for (const client of MCP_CLIENTS) {
    const id = client.id as McpClientId;

    it(`${id}: accepts the client-native shape — present, agent read, URL defaulted`, () => {
      writeNativeFixture(isoHome, id);
      const block = readClientMcpBlock(id, isoHome);
      expect(block.present).toBe(true);
      expect(block.agentId).toBe("canary");
      expect(block.flairUrl).toBeUndefined();
      expect(block.urlDefaulted).toBe(true);
    });

    it(`${id}: fixture still expresses the defect class — no FLAIR_URL anywhere in it`, () => {
      // Every client's documented native wiring sets only FLAIR_AGENT_ID
      // (flair-client defaults the URL). A FLAIR_URL sneaking into a fixture
      // means it was regenerated from our wire functions — which always
      // write one — and no longer tests what the client writes.
      expect(NATIVE_FIXTURES[id].includes("FLAIR_URL")).toBe(false);
    });

    it(`${id}: drift detection — fixture is NOT byte-identical to our wire function's output`, () => {
      // Kern's ruling, point 4: a fixture matching our own generator is not
      // testing the defect class. If this fires, do NOT "fix" the fixture by
      // regenerating it — re-capture it from the client's own tooling.
      const wired = ourWireOutput(id);
      expect(NATIVE_FIXTURES[id]).not.toBe(wired);
      if (id === "codex") {
        // The TOML generator's raw snippet is the entry-level equivalent.
        expect(NATIVE_FIXTURES[id]).not.toBe(tomlSnippet(WIRE_ENV) + "\n");
      } else {
        // Whole-file inequality could be satisfied by sibling keys alone
        // (claude-code's fixture carries real top-level state), so also pin
        // inequality of the flair ENTRY itself.
        const fixtureEntry = JSON.stringify(JSON.parse(NATIVE_FIXTURES[id]).mcpServers.flair);
        const wiredEntry = JSON.stringify(JSON.parse(wired).mcpServers.flair);
        expect(fixtureEntry).not.toBe(wiredEntry);
      }
    });
  }

  it("claude-code: the fixture carries the literal `type: \"stdio\"` field `claude mcp add` writes", () => {
    // The 2026-08-19 canary's observed shape. Presence detection must ignore
    // extra client-written fields; this pins that the fixture keeps carrying
    // one (our own generator never writes `type`).
    expect(JSON.parse(CLAUDE_CODE_NATIVE).mcpServers.flair.type).toBe("stdio");
  });

  it("codex: also accepts the inline env table form codex preserves for hand-written entries", () => {
    // `codex mcp add` serializes env as a sub-table, but PRESERVES an entry a
    // user hand-wrote as an inline table (merge_inline_table in the same
    // codex source) — so this is also a codex-native shape doctor must read.
    const toml = [
      "[mcp_servers.flair]",
      'command = "npx"',
      'args = ["-y", "@tpsdev-ai/flair-mcp@0.46.0"]',
      'env = { "FLAIR_AGENT_ID" = "canary" }',
      "",
    ].join("\n");
    const path = join(isoHome, ".codex", "config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, toml);
    const block = readClientMcpBlock("codex", isoHome);
    expect(block.present).toBe(true);
    expect(block.agentId).toBe("canary");
    expect(block.urlDefaulted).toBe(true);
  });

  it("codex: inline env table with bare (unquoted) keys reads the same", () => {
    const toml = [
      "[mcp_servers.flair]",
      'command = "npx"',
      'args = ["-y", "@tpsdev-ai/flair-mcp@0.46.0"]',
      'env = { FLAIR_AGENT_ID = "canary", FLAIR_URL = "http://127.0.0.1:9926" }',
      "",
    ].join("\n");
    const path = join(isoHome, ".codex", "config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, toml);
    const block = readClientMcpBlock("codex", isoHome);
    expect(block.present).toBe(true);
    expect(block.agentId).toBe("canary");
    expect(block.flairUrl).toBe("http://127.0.0.1:9926");
    expect(block.urlDefaulted).toBe(false);
  });
});

// ── the env-var-incomplete case, explicitly (Kern's ruling, point 5) ────────

describe("env-incomplete-but-working block (flair#1287)", () => {
  it("FLAIR_AGENT_ID present + FLAIR_URL absent → present, urlDefaulted, and the effective URL is flair-client's default", () => {
    writeFileSync(
      join(isoHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          flair: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@tpsdev-ai/flair-mcp@0.46.0"],
            env: { FLAIR_AGENT_ID: "canary" },
          },
        },
      }),
    );
    const block = readClientMcpBlock("claude-code", isoHome);
    expect(block.present).toBe(true);
    expect(block.urlDefaulted).toBe(true);
    const eff = effectiveFlairUrl(block);
    expect(eff.defaulted).toBe(true);
    expect(eff.url).toBe(FLAIR_CLIENT_DEFAULT_URL);
  });

  it("an explicit FLAIR_URL passes through effectiveFlairUrl untouched (not defaulted)", () => {
    const eff = effectiveFlairUrl({ flairUrl: "http://harper.local:19926" });
    expect(eff.defaulted).toBe(false);
    expect(eff.url).toBe("http://harper.local:19926");
  });

  it("FLAIR_CLIENT_DEFAULT_URL matches flair-client's own DEFAULT_URL source — the two cannot drift silently", () => {
    // doctor-client duplicates the value (flair-client doesn't export it);
    // this reads the authoritative source line so a change there fails here.
    const src = readFileSync(
      join(import.meta.dirname, "..", "..", "packages", "flair-client", "src", "client.ts"),
      "utf-8",
    );
    const m = src.match(/const DEFAULT_URL = "([^"]+)"/);
    expect(m?.[1]).toBe(FLAIR_CLIENT_DEFAULT_URL);
  });
});
