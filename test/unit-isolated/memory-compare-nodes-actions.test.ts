/** `flair memory compare-nodes` Commander action, with a fake per-node ops transport. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { program } from "../../src/cli.ts";

const dir = mkdtempSync(join(tmpdir(), "flair-compare-nodes-actions-unit-"));
const password = join(dir, "password");
const credential = "compare-fixture-password";
writeFileSync(password, credential, { mode: 0o600 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NODE_A = "https://node-a.example.invalid";
const NODE_B = "https://node-b.example.invalid";

type Row = { id: string; durability: string; createdAt: string; updatedAt: string | null };
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const row = (id: string, updatedAt: string | null): Row => ({ id, durability: "standard", createdAt: T0, updatedAt });

const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];

/** Run the real commander program against a fake ops transport keyed by node origin. */
async function action(
  args: string[],
  rows: Record<string, Row[]>,
  opts: { failHosts?: string[]; inheritUser?: string | null } = {},
): Promise<{ code: number; output: string }> {
  const failHosts = new Set(opts.failHosts ?? []);
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalUser = process.env.FABRIC_USER;
  const output: string[] = [];
  const exited = Symbol("exit");
  let code = 0;
  if (opts.inheritUser === null) delete process.env.FABRIC_USER;
  else process.env.FABRIC_USER = opts.inheritUser ?? "admin";
  globalThis.fetch = (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body, auth: new Headers(init?.headers).get("Authorization") });
    const origin = new URL(String(url)).origin;
    if (failHosts.has(origin)) throw new Error("connect ECONNREFUSED 127.0.0.1");
    const nodeRows = rows[origin] ?? [];
    if (body.operation === "describe_table") return Response.json({ record_count: nodeRows.length });
    return Response.json(nodeRows);
  }) as typeof fetch;
  process.exit = ((n?: number) => { code = n ?? 0; throw exited; }) as typeof process.exit;
  console.log = console.error = (...a: unknown[]) => { output.push(a.join(" ")); };
  try {
    await program.parseAsync(["node", "flair", ...args]);
  } catch (err) {
    if (err !== exited) throw err;
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    if (originalUser === undefined) delete process.env.FABRIC_USER;
    else process.env.FABRIC_USER = originalUser;
  }
  return { code, output: output.join("\n") };
}

function args(...nodes: string[]) {
  return ["memory", "compare-nodes", ...nodes.flatMap((n) => ["--node", n]), "--fabric-password-file", password];
}

describe("Memory compare-nodes Commander action", () => {
  test("two nodes with the same ids are healthy and the read asks for the stored-timestamp columns", async () => {
    calls.length = 0;
    const rows = { [NODE_A]: [row("mem-1", T1), row("mem-2", null)], [NODE_B]: [row("mem-1", T1), row("mem-2", null)] };
    const result = await action(args(NODE_A, NODE_B), rows);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("HEALTHY");
    const sql = calls.filter((c) => c.body.operation === "sql");
    expect(sql.length).toBeGreaterThan(0);
    for (const call of sql) {
      expect(call.body).toEqual({ operation: "sql", sql: "SELECT id, durability, createdAt, updatedAt FROM flair.Memory ORDER BY id LIMIT 10000" });
    }
    for (const call of calls) {
      expect(call.auth).toBe(`Basic ${Buffer.from(`admin:${credential}`).toString("base64")}`);
    }
  }, 10_000);

  test("a node missing an id the other holds is reported non-healthy (exit 2)", async () => {
    const rows = { [NODE_A]: [row("mem-1", T1), row("mem-2", T1)], [NODE_B]: [row("mem-1", T1)] };
    const result = await action(args(NODE_A, NODE_B), rows);
    expect(result.code, result.output).toBe(2);
    expect(result.output).toContain("DIVERGENT");
  }, 10_000);

  test("--json prints the per-node result", async () => {
    const rows = { [NODE_A]: [row("mem-1", T1)], [NODE_B]: [row("mem-1", T1)] };
    const result = await action([...args(NODE_A, NODE_B), "--json"], rows);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.output) as { verdict: string; nodes: { node: string }[] };
    expect(parsed.verdict).toBe("healthy");
    expect(parsed.nodes.map((n) => n.node).sort()).toEqual([NODE_A, NODE_B]);
  }, 10_000);

  test("an unreachable node is unknown (exit 3), never healthy", async () => {
    const rows = { [NODE_A]: [row("mem-1", T1)], [NODE_B]: [row("mem-1", T1)] };
    const result = await action(args(NODE_A, NODE_B), rows, { failHosts: [NODE_B] });
    expect(result.code, result.output).toBe(3);
    expect(result.output).toContain("UNKNOWN");
  }, 10_000);

  test("fewer than two --node values is a usage error (exit 1)", async () => {
    const result = await action(args(NODE_A), { [NODE_A]: [] });
    expect(result.code).toBe(1);
    expect(result.output).toContain("at least two --node");
  }, 10_000);

  test("a repeated --node is refused (exit 1)", async () => {
    const result = await action(args(NODE_A, NODE_A), { [NODE_A]: [] });
    expect(result.code).toBe(1);
    expect(result.output).toContain("given more than once");
  }, 10_000);

  test("a non-HTTP(S) node URL is refused before any request (exit 1)", async () => {
    calls.length = 0;
    const result = await action(args("file:///etc/passwd", NODE_A), { [NODE_A]: [] });
    expect(result.code).toBe(1);
    expect(result.output).toContain("must be an HTTP(S) operations API origin");
    expect(calls).toEqual([]);
  }, 10_000);

  test("a rejected credential-bearing node URL exits without printing either credential", async () => {
    const child = Bun.spawn([
      process.execPath, "src/cli.ts",
      ...args("https://compare-url-user:compare-url-password@node-a.example.invalid/", NODE_B),
    ], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(1);
    for (const output of [stdout, stderr]) {
      expect(output).not.toContain("compare-url-user");
      expect(output).not.toContain("compare-url-password");
    }
  }, 15_000);

  test("node URL paths, queries and fragments are removed before reading", async () => {
    calls.length = 0;
    const result = await action(args(`${NODE_A}/path?query=1#fragment`, NODE_B), {});
    expect(result.code).toBe(0);
    expect(calls.map((call) => call.url)).toContain(`${NODE_A}/`);
    expect(calls.every((call) => call.url === `${NODE_A}/` || call.url === `${NODE_B}/`)).toBe(true);
  }, 10_000);

  test("without credentials it exits 1 before reading any node", async () => {
    calls.length = 0;
    const result = await action(
      ["memory", "compare-nodes", "--node", NODE_A, "--node", NODE_B],
      { [NODE_A]: [], [NODE_B]: [] },
      { inheritUser: null },
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("credentials required");
    expect(calls).toEqual([]);
  }, 10_000);
});
