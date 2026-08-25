// cli-credential-identity-flags.test.ts — flair#1106
//
// Sibling commands (memory add, backup, federation sync) drifted on the same
// credential/identity concepts: `--admin-pass-file` was accepted on backup
// and federation sync but was an unknown option on `memory add`, and
// `memory add --agent` was a commander requiredOption so FLAIR_AGENT_ID
// could never satisfy it — even though the error text named the env var.
//
// This file pins two things:
//   1. THE SURFACE — the three commands declare the same credential flag
//      names and argument shapes (and memory add's --agent is optional).
//   2. THE ACCEPTANCE — `memory add` actually accepts `--admin-pass-file`
//      and honors FLAIR_AGENT_ID without `--agent`. Commander never gets
//      to say "required option '--agent <id>' not specified".

import { describe, test, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { program, SHARED_CREDENTIAL_FLAGS, SHARED_IDENTITY_FLAGS } from "../../src/cli";

function findCommand(root: { commands: readonly { name: () => string }[] }, path: string[]): any {
  let node: any = root;
  for (const name of path) {
    node = node.commands.find((c: any) => c.name() === name);
    if (!node) return null;
  }
  return node;
}

function optionByLong(cmd: any, long: string): { flags: string; mandatory: boolean } | undefined {
  const opt = cmd?.options?.find((o: any) => o.long === long);
  if (!opt) return undefined;
  // Commander: `required` means the *argument* is required (`<id>` vs `[id]`).
  // `mandatory` is what `.requiredOption()` sets — the flag itself must be present.
  return { flags: opt.flags, mandatory: !!opt.mandatory };
}

const SIBLINGS: { name: string; path: string[] }[] = [
  { name: "memory add", path: ["memory", "add"] },
  { name: "backup", path: ["backup"] },
  { name: "federation sync", path: ["federation", "sync"] },
];

describe("flair#1106 — sibling commands share one credential flag surface", () => {
  test("backup, federation sync, and memory add declare the same --admin-pass / --admin-pass-file / --admin-user shapes", () => {
    const expected = [
      SHARED_CREDENTIAL_FLAGS.adminPass,
      SHARED_CREDENTIAL_FLAGS.adminPassFile,
      SHARED_CREDENTIAL_FLAGS.adminUser,
    ];

    for (const sibling of SIBLINGS) {
      const cmd = findCommand(program, sibling.path);
      expect(cmd).not.toBeNull();
      const flags = cmd.options.map((o: any) => o.flags);
      for (const shape of expected) {
        expect(flags).toContain(shape);
      }
      // None of these are commander-required: missing values fall through to
      // env / file / an action-level error that names the real remedies.
      for (const shape of expected) {
        const long = shape.split(" ")[0];
        const opt = optionByLong(cmd, long);
        expect(opt?.mandatory).toBe(false);
      }
    }
  });

  test("the three siblings agree with each other, not just with the shared constants", () => {
    const shapes = SIBLINGS.map((sibling) => {
      const cmd = findCommand(program, sibling.path);
      return ["--admin-pass", "--admin-pass-file", "--admin-user"].map((long) => {
        const opt = optionByLong(cmd, long);
        return `${long}=${opt?.flags ?? "MISSING"}`;
      });
    });
    expect(shapes[0]).toEqual(shapes[1]);
    expect(shapes[1]).toEqual(shapes[2]);
  });

  test("memory add --agent is optional (FLAIR_AGENT_ID can satisfy it) and uses the shared identity shape", () => {
    const add = findCommand(program, ["memory", "add"]);
    const agent = optionByLong(add, "--agent");
    expect(agent).toBeTruthy();
    expect(agent!.flags).toBe(SHARED_IDENTITY_FLAGS.agent);
    expect(agent!.mandatory).toBe(false);
  });
});

type Capture = { method?: string; path?: string; body?: any; authorization?: string };

function startMockServer(onRequest: (cap: Capture) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: any = undefined;
        try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
        onRequest({
          method: req.method,
          path: req.url,
          body: parsed,
          authorization: req.headers.authorization,
        });
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

describe("flair#1106 — memory add accepts the shared flags for real", () => {
  it("rejects --admin-pass-file as a known flag (file missing), not as an unknown option", async () => {
    const r = await runCli(
      ["memory", "add", "hello", "--agent", "krais", "--admin-pass-file", "/no/such/admin-pass"],
      { ...process.env, FLAIR_AGENT_ID: "" },
    );
    const text = `${r.stderr}${r.stdout}`;
    expect(text.toLowerCase()).not.toMatch(/unknown option/);
    expect(text).toMatch(/--admin-pass-file/);
    expect(r.code).not.toBe(0);
  });

  it("does not treat --agent as a commander requiredOption when FLAIR_AGENT_ID is unset", async () => {
    const r = await runCli(
      ["memory", "add", "hello"],
      { ...process.env, FLAIR_AGENT_ID: "" },
    );
    const text = `${r.stderr}${r.stdout}`;
    expect(text).not.toMatch(/required option '--agent/);
    expect(text).toMatch(/--agent <id> required \(or set FLAIR_AGENT_ID\)/);
    expect(r.code).not.toBe(0);
  });

  it("writes the memory under FLAIR_AGENT_ID when --agent is omitted", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code, stderr, stdout } = await runCli(
        ["memory", "add", "env-identity memory"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "krais" },
      );
      expect(code).toBe(0);
      expect(`${stderr}${stdout}`).not.toMatch(/required option '--agent/);

      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put).toBeTruthy();
      expect(put!.body.agentId).toBe("krais");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("accepts --admin-pass-file and sends Basic auth from the file (shared credential path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-1106-"));
    const passFile = join(dir, "admin-pass");
    writeFileSync(passFile, "file-secret-pass\n", { mode: 0o600 });
    chmodSync(passFile, 0o600);

    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code, stderr, stdout } = await runCli(
        ["memory", "add", "file-cred memory", "--admin-pass-file", passFile],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "krais", FLAIR_ADMIN_PASS: "" },
      );
      expect(`${stderr}${stdout}`).not.toMatch(/unknown option/);
      expect(code).toBe(0);

      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put).toBeTruthy();
      expect(put!.body.agentId).toBe("krais");
      const expected = `Basic ${Buffer.from("admin:file-secret-pass").toString("base64")}`;
      expect(put!.authorization).toBe(expected);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
