/**
 * cli-entities-option.test.ts — `--entities <csv>` on the three CLI write
 * commands (flair#1288, nightly-canary 2026-08-19 finding 2).
 *
 * `docs/entity-vocabulary.md` documents `entities: [String] @indexed` on
 * Memory / WorkspaceState / OrgEvent, but no CLI surface reached it. This
 * suite pins the new option on `memory add`, `workspace set`, and `orgevent`:
 *
 *   - accepted entities land on the written record (the PUT body — same
 *     mock-server technique as cli-memory-add-derived-from.test.ts /
 *     orgevent-cli.test.ts; the server-side persistence gate for these
 *     tables is invalidEntitiesResponse, covered below and in the resources
 *     suites);
 *   - a malformed value is rejected client-side, exit 1, with a message that
 *     names the `type:value` format AND enumerates the closed type set
 *     (errors must enable a response — canary finding 5's class), and the
 *     rejection fires BEFORE any request is made (zero writes on the mock);
 *   - the CLI's inlined vocabulary copy (src/lib/entity-vocab-cli.ts) cannot
 *     drift from the canonical resources/entity-vocab.ts: ENTITY_TYPES,
 *     validator verdicts over a known-answer table (expected verdicts
 *     asserted, so the parity check can't go vacuous), and the
 *     entityFormatHint() string are pinned 1:1;
 *   - the server-side invalid_entities 400 body now carries the same
 *     actionable `message` (additive field — `error`/`invalid` unchanged).
 *
 * HOME is pointed at the per-test tmp dir and keys live in a per-test
 * FLAIR_KEY_DIR — no invocation can touch a real ~/.flair.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";

import {
  ENTITY_TYPES as CLI_ENTITY_TYPES,
  isValidEntity as cliIsValidEntity,
  entityFormatHint as cliEntityFormatHint,
  parseEntitiesCsv,
} from "../../src/lib/entity-vocab-cli";
import {
  ENTITY_TYPES as CANONICAL_ENTITY_TYPES,
  isValidEntity as canonicalIsValidEntity,
  entityFormatHint as canonicalEntityFormatHint,
  invalidEntitiesResponse,
} from "../../resources/entity-vocab";

const REPO_ROOT = join(import.meta.dirname ?? __dirname, "..", "..");

/** Every assertion on the improved error message, in one place. */
const FORMAT_SNIPPET = "type:value";
const TYPE_LIST_SNIPPET = "valid types: repo, issue, customer, subsystem, agent, person";

type Capture = { method?: string; path?: string; body?: any };

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-entities-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function startCaptureServer(captures: Capture[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: any = undefined;
        try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
        captures.push({ method: req.method, path: req.url, body: parsed });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: "mock-id" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function writeAgentKey(keysDir: string, agentId: string): void {
  const kp = nacl.sign.keyPair();
  const seed = kp.secretKey.slice(0, 32);
  writeFileSync(join(keysDir, `${agentId}.key`), Buffer.from(seed));
  chmodSync(join(keysDir, `${agentId}.key`), 0o600);
}

describe("--entities on the CLI write commands (flair#1288)", () => {
  let tmpDir: string;
  let keysDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    keysDir = join(tmpDir, "keys");
    mkdirSync(keysDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn("bun", ["src/cli.ts", ...args], {
        cwd: REPO_ROOT,
        // HOME → tmp dir: no invocation may read or write the real ~/.flair.
        env: { ...process.env, HOME: tmpDir, FLAIR_KEY_DIR: keysDir, ...env },
      });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
    });
  }

  function expectImprovedMessage(stderr: string, offending: string): void {
    expect(stderr).toContain("invalid --entities value");
    expect(stderr).toContain(offending);
    expect(stderr).toContain(FORMAT_SNIPPET);
    expect(stderr).toContain(TYPE_LIST_SNIPPET);
  }

  // ── flair memory add ──────────────────────────────────────────────────────

  it("memory add: accepted entities land on the written record (CSV split + trim)", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startCaptureServer(captures);
    try {
      const { code } = await runCli(
        ["memory", "add", "attention-plane memory", "--agent", "krais",
         "--entities", "repo:tpsdev-ai/flair, issue:tpsdev-ai/flair#1288"],
        { FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put).toBeTruthy();
      expect(put!.body.entities).toEqual(["repo:tpsdev-ai/flair", "issue:tpsdev-ai/flair#1288"]);
    } finally {
      await stopServer(server);
    }
  });

  it("memory add: omitting --entities leaves the field off the record (no regression)", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startCaptureServer(captures);
    try {
      const { code } = await runCli(
        ["memory", "add", "a plain memory", "--agent", "krais"],
        { FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put).toBeTruthy();
      expect(put!.body.entities).toBeUndefined();
    } finally {
      await stopServer(server);
    }
  });

  it("memory add: an unknown entity type is rejected with the format + type-set message, before any write", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startCaptureServer(captures);
    try {
      const { code, stderr } = await runCli(
        ["memory", "add", "content", "--agent", "krais", "--entities", "repo:tpsdev-ai/flair,project:foo"],
        { FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code).toBe(1);
      expectImprovedMessage(stderr, "project:foo");
      expect(captures.length).toBe(0); // validation fires BEFORE the write path
    } finally {
      await stopServer(server);
    }
  });

  it("memory add: a colon-less value is rejected with the same message", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startCaptureServer(captures);
    try {
      const { code, stderr } = await runCli(
        ["memory", "add", "content", "--agent", "krais", "--entities", "not-a-vocab-string"],
        { FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code).toBe(1);
      expectImprovedMessage(stderr, "not-a-vocab-string");
      expect(captures.length).toBe(0);
    } finally {
      await stopServer(server);
    }
  });

  // ── flair workspace set ───────────────────────────────────────────────────

  it("workspace set: accepted entities land on the written record", async () => {
    const agentId = "test-agent-ws";
    writeAgentKey(keysDir, agentId);
    const captures: Capture[] = [];
    const { server, url } = await startCaptureServer(captures);
    try {
      const { code } = await runCli(
        ["workspace", "set", "--ref", "feat/1288-entities-cli", "--entities", "repo:tpsdev-ai/flair,subsystem:attention_plane"],
        { FLAIR_AGENT_ID: agentId, FLAIR_URL: url },
      );
      expect(code).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/WorkspaceState/"));
      expect(put).toBeTruthy();
      expect(put!.body.entities).toEqual(["repo:tpsdev-ai/flair", "subsystem:attention_plane"]);
      expect(put!.body.agentId).toBe(agentId);
    } finally {
      await stopServer(server);
    }
  });

  it("workspace set: a malformed entity is rejected with the format + type-set message, before any write", async () => {
    const agentId = "test-agent-ws";
    writeAgentKey(keysDir, agentId);
    const captures: Capture[] = [];
    const { server, url } = await startCaptureServer(captures);
    try {
      const { code, stderr } = await runCli(
        ["workspace", "set", "--ref", "feat/x", "--entities", "repo:UPPER/Case"],
        { FLAIR_AGENT_ID: agentId, FLAIR_URL: url },
      );
      expect(code).toBe(1);
      expectImprovedMessage(stderr, "repo:UPPER/Case");
      expect(captures.length).toBe(0);
    } finally {
      await stopServer(server);
    }
  });

  // ── flair orgevent ────────────────────────────────────────────────────────

  it("orgevent: accepted entities land on the written record", async () => {
    const agentId = "test-agent-oe";
    writeAgentKey(keysDir, agentId);
    const captures: Capture[] = [];
    const { server, url } = await startCaptureServer(captures);
    try {
      const { code } = await runCli(
        ["orgevent", "--kind", "coord.claim", "--summary", "claiming the attention plane",
         "--entities", "repo:tpsdev-ai/flair,agent:flint"],
        { FLAIR_AGENT_ID: agentId, FLAIR_URL: url },
      );
      expect(code).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/OrgEvent/"));
      expect(put).toBeTruthy();
      expect(put!.body.entities).toEqual(["repo:tpsdev-ai/flair", "agent:flint"]);
      expect(put!.body.authorId).toBe(agentId);
    } finally {
      await stopServer(server);
    }
  });

  it("orgevent: a malformed entity is rejected with the format + type-set message, before any write", async () => {
    const agentId = "test-agent-oe";
    writeAgentKey(keysDir, agentId);
    const captures: Capture[] = [];
    const { server, url } = await startCaptureServer(captures);
    try {
      const { code, stderr } = await runCli(
        ["orgevent", "--kind", "status", "--summary", "hi", "--entities", "issue:tpsdev-ai/flair#0"],
        { FLAIR_AGENT_ID: agentId, FLAIR_URL: url },
      );
      expect(code).toBe(1);
      expectImprovedMessage(stderr, "issue:tpsdev-ai/flair#0");
      expect(captures.length).toBe(0);
    } finally {
      await stopServer(server);
    }
  });
});

// ── the inlined CLI copy is pinned to the canonical module ──────────────────
//
// src/lib/entity-vocab-cli.ts exists only because cli.ts cannot import across
// the src/ → resources/ packaging boundary (tsconfig.cli.json rootDir). These
// tests are the stay-in-sync guard: extend resources/entity-vocab.ts without
// the CLI copy (or vice versa) and this file goes red.

describe("entity-vocab-cli stays in sync with resources/entity-vocab.ts", () => {
  it("ENTITY_TYPES are identical", () => {
    expect([...CLI_ENTITY_TYPES]).toEqual([...CANONICAL_ENTITY_TYPES]);
  });

  it("entityFormatHint() is byte-identical (and names the format + every type)", () => {
    expect(cliEntityFormatHint()).toBe(canonicalEntityFormatHint());
    expect(cliEntityFormatHint()).toContain(FORMAT_SNIPPET);
    for (const t of CANONICAL_ENTITY_TYPES) {
      expect(cliEntityFormatHint()).toContain(t);
    }
  });

  it("validator verdicts agree across a known-answer table (expected verdicts asserted — parity can't go vacuous)", () => {
    const KNOWN: Array<[entity: string, valid: boolean]> = [
      ["repo:tpsdev-ai/flair", true],
      ["issue:tpsdev-ai/flair#1288", true],
      ["customer:acme-corp", true],
      ["subsystem:memory_core", true],
      ["agent:flint", true],
      ["person:nathan", true],
      ["project:foo", false],             // unknown type
      ["not-a-vocab-string", false],      // no colon
      ["repo:noslash", false],            // repo needs owner/name
      ["repo:Tpsdev/Flair", false],       // lowercase only
      ["issue:tpsdev-ai/flair#0", false], // issue number must be positive, no leading zero
      ["customer:-bad", false],           // slug: no leading separator
      ["repo:", false],                   // empty value
      [":value", false],                  // empty type
    ];
    for (const [entity, valid] of KNOWN) {
      expect(cliIsValidEntity(entity)).toBe(valid);
      expect(canonicalIsValidEntity(entity)).toBe(valid);
    }
  });
});

describe("parseEntitiesCsv", () => {
  it("splits on commas, trims, drops empties, reports the invalid subset", () => {
    const { entities, invalid } = parseEntitiesCsv(" repo:tpsdev-ai/flair , ,project:foo,agent:flint,");
    expect(entities).toEqual(["repo:tpsdev-ai/flair", "project:foo", "agent:flint"]);
    expect(invalid).toEqual(["project:foo"]);
  });

  it("an all-valid CSV reports nothing invalid", () => {
    const { invalid } = parseEntitiesCsv("repo:tpsdev-ai/flair,person:nathan");
    expect(invalid).toEqual([]);
  });
});

describe("invalidEntitiesResponse (server-side write rejection)", () => {
  it("keeps error/invalid shapes and adds an actionable message naming the format + type set (flair#1288)", async () => {
    const res = invalidEntitiesResponse(["project:foo"]);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.error).toBe("invalid_entities");
    expect(body.invalid).toEqual(["project:foo"]);
    expect(body.message).toContain("project:foo");
    expect(body.message).toContain(FORMAT_SNIPPET);
    expect(body.message).toContain(TYPE_LIST_SNIPPET);
  });
});
