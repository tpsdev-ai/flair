// cli-memory-add-visibility.test.ts — Flair #509
//
// `flair memory add` must expose `--visibility <value>` so a CLI-written
// memory can be shared office-wide (`visibility=office`) without setting up a
// per-pair `flair grant` for every team agent. Before the fix the option
// didn't exist, so a memory could only ever be written private-by-default.
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
  it("sets visibility=office on the written memory so it's shared office-wide", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code } = await runCli(
        ["memory", "add", "team-wide announcement", "--agent", "krais", "--visibility", "office"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code).toBe(0);

      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put).toBeTruthy();
      expect(put!.body.visibility).toBe("office");
      expect(put!.body.agentId).toBe("krais");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("trims surrounding whitespace on the visibility value", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code } = await runCli(
        ["memory", "add", "another shared note", "--agent", "krais", "--visibility", "  office  "],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
      );
      expect(code).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put!.body.visibility).toBe("office");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("omits visibility when --visibility is not passed (stays private-by-default; no regression)", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code } = await runCli(
        ["memory", "add", "a private memory", "--agent", "krais"],
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
});
