// cli-relationship-add.test.ts — relationship-write-path spec
//
// `flair relationship add` is the CLI leg of the ergonomic agent-directed
// write surface (alongside RelationshipApi in flair-client and the
// relationship_store MCP tool). It PUTs to a CANONICAL id — derived from
// SHA-256(lowercased agentId+subject+predicate+object), truncated to 16
// bytes/base64url — computed by a LOCAL copy of the algorithm (src/cli.ts
// can't import the @tpsdev-ai/flair-client workspace package into the
// published CLI bundle, mirroring the existing Memory-id-generation
// duplication pattern already in this file).
//
// We spawn the real CLI against a mock HTTP server (FLAIR_URL), capture the
// PUT /Relationship/<id> body + path, and assert:
//   - the triple fields land in the body, agentId is set from --agent
//   - the URL id is deterministic (same triple -> same id, twice)
//   - a different triple produces a different id
//   - the id EXACTLY matches flair-client's own canonicalRelationshipId() for
//     the same inputs — a cross-check drift-guard: if the CLI's local copy
//     ever diverges from flair-client's, the CLI and the MCP tool would file
//     the SAME triple under TWO different ids, silently defeating dedup.
//
// Mirrors test/unit/cli-memory-add-derived-from.test.ts's mock-server +
// spawn-the-real-CLI pattern.

import { describe, it, expect } from "bun:test";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { spawn } from "node:child_process";
import { canonicalRelationshipId } from "../../packages/flair-client/src/client";

type Capture = { method?: string; path?: string; body?: any };

function startMockServer(onRequest: (cap: Capture) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: any = undefined;
        try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
        onRequest({ method: req.method, path: req.url, body: parsed });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["src/cli.ts", ...args], { cwd: ".", env });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

describe("flair relationship add (relationship-write-path)", () => {
  it("PUTs the triple to /Relationship/<canonical-id> with agentId from --agent", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code, stderr } = await runCli(
        ["relationship", "add", "--agent", "flint", "--subject", "nathan", "--predicate", "manages", "--object", "flair"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code, stderr).toBe(0);

      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Relationship/"));
      expect(put).toBeTruthy();
      expect(put!.body.agentId).toBe("flint");
      expect(put!.body.subject).toBe("nathan");
      expect(put!.body.predicate).toBe("manages");
      expect(put!.body.object).toBe("flair");
      expect(put!.body.id).toBe(put!.path!.split("/Relationship/")[1]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("forwards --confidence/--valid-from/--valid-to/--source only when passed", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code, stderr } = await runCli(
        [
          "relationship", "add", "--agent", "flint",
          "--subject", "nathan", "--predicate", "manages", "--object", "flair",
          "--confidence", "0.8", "--valid-from", "2026-01-01T00:00:00Z", "--source", "mem-123",
        ],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code, stderr).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Relationship/"));
      expect(put!.body.confidence).toBe(0.8);
      expect(put!.body.validFrom).toBe("2026-01-01T00:00:00Z");
      expect(put!.body.source).toBe("mem-123");
      expect(put!.body.validTo).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("re-running with the SAME triple writes to the SAME canonical id (upsert, not a new row)", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      await runCli(
        ["relationship", "add", "--agent", "flint", "--subject", "nathan", "--predicate", "manages", "--object", "flair", "--confidence", "1.0"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      await runCli(
        ["relationship", "add", "--agent", "flint", "--subject", "nathan", "--predicate", "manages", "--object", "flair", "--confidence", "0.5"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      const puts = captures.filter((c) => c.method === "PUT" && c.path?.startsWith("/Relationship/"));
      expect(puts).toHaveLength(2);
      expect(puts[0].path).toBe(puts[1].path);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a DIFFERENT triple (different predicate) writes to a DIFFERENT canonical id", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      await runCli(
        ["relationship", "add", "--agent", "flint", "--subject", "nathan", "--predicate", "manages", "--object", "flair"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      await runCli(
        ["relationship", "add", "--agent", "flint", "--subject", "nathan", "--predicate", "advises", "--object", "flair"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      const puts = captures.filter((c) => c.method === "PUT" && c.path?.startsWith("/Relationship/"));
      expect(puts).toHaveLength(2);
      expect(puts[0].path).not.toBe(puts[1].path);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("DRIFT GUARD: the CLI's local canonical-id algorithm matches flair-client's canonicalRelationshipId() exactly", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code, stderr } = await runCli(
        ["relationship", "add", "--agent", "flint", "--subject", "Nathan", "--predicate", "MANAGES", "--object", "Flair"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code, stderr).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Relationship/"));
      const cliId = put!.path!.split("/Relationship/")[1];

      const clientId = canonicalRelationshipId("flint", "Nathan", "MANAGES", "Flair");
      expect(cliId).toBe(clientId);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
