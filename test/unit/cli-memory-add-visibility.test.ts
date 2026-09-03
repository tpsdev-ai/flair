// cli-memory-add-visibility.test.ts — Flair #509, hardened by #991
//
// `flair memory add` must expose `--visibility <value>` so a CLI-written
// memory can be shared across the instance without setting up a per-pair
// `flair grant` for every team agent. Before #509 the option didn't exist, so
// a memory could only ever be written private-by-default.
//
// ── #991: the accepted values are now an allowlist, and "office" is gone ───
// `visibility` is a free-form String in schemas/memory.graphql, and the read
// scope asks isPrivateVisibility() — an exact match on the literal "private"
// (resources/memory-visibility.ts). So EVERY other string reads as
// non-private and is returned to every agent on the instance. Passing an
// unrecognized value through therefore had exactly one possible outcome:
// `--visibility prvate` writing a row the user believes is owner-only that
// every agent can in fact read. A typo must never widen who can read a
// memory, so the CLI now rejects anything that is not "private" or "shared".
//
// That retires "office", which these tests used to pin. The office tier was a
// real read-scope branch when #509 landed; it was REMOVED as a read leak (see
// resources/memory-read-scope.ts's module doc — the `visibility === "office"`
// global OR-clause returned office memories to any authenticated caller).
// Today "office" survives only in historical comments: it has no branch
// anywhere in the read path, so an office-stamped row is indistinguishable
// from a shared one. The CLI advertising a tier the system does not implement
// is the defect; "shared" is the value that means what "office" used to mean.
//
// We spawn the real CLI against a mock HTTP server (FLAIR_URL), capture the PUT
// /Memory/<id> body, and assert visibility is populated. Mirrors
// cli-memory-add-derived-from.test.ts.

import { describe, it, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, Server } from "node:http";

type Capture = { method?: string; path?: string; body?: any };

function startMockServer(onRequest: (cap: Capture) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
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

describe("flair memory add --visibility (Flair #509)", () => {
  it("sets visibility=shared on the written memory so every agent on the instance can read it", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code } = await runCli(
        ["memory", "add", "team-wide announcement", "--agent", "krais", "--admin-pass", "test-admin", "--visibility", "shared"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code).toBe(0);

      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put).toBeTruthy();
      expect(put!.body.visibility).toBe("shared");
      expect(put!.body.agentId).toBe("krais");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("sets visibility=private on the written memory so it stays owner-only", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code } = await runCli(
        ["memory", "add", "a deliberately private note", "--agent", "krais", "--admin-pass", "test-admin", "--visibility", "private"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put!.body.visibility).toBe("private");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("trims surrounding whitespace on the visibility value", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code } = await runCli(
        ["memory", "add", "another shared note", "--agent", "krais", "--admin-pass", "test-admin", "--visibility", "  shared  "],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put!.body.visibility).toBe("shared");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("omits visibility when --visibility is not passed (server applies the durability-keyed default)", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code } = await runCli(
        ["memory", "add", "a private memory", "--agent", "krais", "--admin-pass", "test-admin"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put).toBeTruthy();
      expect(put!.body.visibility).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  // ─── #991: a typo must never widen who can read a memory ──────────────────
  //
  // Each of these asserts BOTH halves of the guard: a non-zero exit AND that
  // no write reached the server. Asserting only the exit code would pass
  // against a CLI that wrote the row and then complained.
  describe("rejects a visibility value the read scope does not implement (#991)", () => {
    for (const bad of ["prvate", "office", "public", "Private", "PRIVATE", "sharedd"]) {
      it(`refuses --visibility ${bad} and writes nothing`, async () => {
        const captures: Capture[] = [];
        const { server, url } = await startMockServer((c) => captures.push(c));
        try {
          const { code, stderr } = await runCli(
            ["memory", "add", "a memory whose visibility is misspelled", "--agent", "krais", "--admin-pass", "test-admin", "--visibility", bad],
            { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
          );
          expect(code).not.toBe(0);
          expect(stderr).toContain("--visibility must be 'private' or 'shared'");
          // The load-bearing half: the row must not have been written. A
          // guard that errors AFTER the PUT has already gone out has not
          // prevented the widening it exists to prevent.
          const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
          expect(put).toBeUndefined();
        } finally {
          await new Promise<void>((r) => server.close(() => r()));
        }
      });
    }
  });
});
