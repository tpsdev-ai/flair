import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { bindCli, register } from "../../src/commands/reembed.ts";
import { setInstancePairOsReadsForTests } from "../../src/lib/local-instance-pair.ts";
import { SIMULATED_LISTENER_TABLE } from "../helpers/simulated-instance-pair";
import { tempDir } from "../helpers/temp-dir";
import { ensureCliBuild } from "../helpers/build-cli-once";
import { shellScript } from "../helpers/shell-script";
import { nodeBin } from "../helpers/node-runtime";

const saved = { fetch: globalThis.fetch, log: console.log, error: console.error, exit: process.exit, exitCode: process.exitCode ?? 0, env: { ...process.env } };
afterEach(() => {
  globalThis.fetch = saved.fetch;
  console.log = saved.log;
  console.error = saved.error;
  process.exit = saved.exit;
  process.exitCode = saved.exitCode;
  process.env = { ...saved.env };
  setInstancePairOsReadsForTests(null);
});

async function run(opts: { agent?: string; httpPort?: number; stamps?: string[]; readFailure?: boolean; dryRun?: boolean; unavailable?: boolean } = {}) {
  const agent = opts.agent ?? "owner";
  const rows = (opts.stamps ?? ["old"]).map((embeddingModel, i) => ({ id: `m-${i}`, agentId: agent, content: "memory", embeddingModel }));
  const requests: Array<{ port: string; method: string; auth: string | null }> = [];
  let targetOptions: unknown;
  const key = join(tempDir("reembed-review-3135-"), "owner.key");
  writeFileSync(key, nacl.sign.keyPair().secretKey.slice(0, 32), { mode: 0o600 });
  process.env.FLAIR_ADMIN_PASS = "test-admin";
  delete process.env.HDB_ADMIN_PASSWORD;
  delete process.env.FLAIR_URL;
  delete process.env.FLAIR_OPS_PORT;
  delete process.env.FLAIR_EMBEDDING_MODEL;
  process.exitCode = 0;
  setInstancePairOsReadsForTests(opts.unavailable ? {
    ...SIMULATED_LISTENER_TABLE,
    listeners: () => ({ kind: "unavailable", reason: "test", remedy: "test" }),
  } : SIMULATED_LISTENER_TABLE);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ port: url.port, method, auth: new Headers(init?.headers).get("Authorization") });
    if (url.pathname === "/Health") return Response.json({ capabilities: ["memory-reembed-patch"] });
    if (url.pathname === "/Instance/") return Response.json([{ id: "instance" }]);
    if (method === "PATCH") return Response.json({ id: decodeURIComponent(url.pathname.split("/").pop()!) });
    const body = JSON.parse(String(init?.body));
    if (body.operation === "get_configuration") return Response.json({ http: { port: 18726 }, operationsApi: { network: { port: 18725 } } });
    if (body.table === "Instance") return Response.json([{ id: "instance" }]);
    if (body.operation === "search_by_id") {
      if (opts.readFailure) return new Response("failed", { status: 500 });
      return Response.json(rows.filter(row => body.ids.includes(row.id)));
    }
    if (body.operation === "search_by_conditions") return Response.json(rows);
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  bindCli({
    privKeyPath: () => key,
    resolveHttpPort: options => Number(options.port),
    resolveOpsPort: options => Number(options.opsPort),
    resolveAgentHomeTarget: options => {
      targetOptions = options;
      return { httpPort: Number(options.port), opsPort: Number(options.opsPort), pairBound: true };
    },
    ambiguousInstanceTargetError: "ambiguous_instance_target",
  });
  const logs: string[] = [];
  console.log = console.error = (...args: unknown[]) => { logs.push(args.join(" ")); };
  process.exit = ((code: number) => { throw new Error(`EXIT:${code}`); }) as typeof process.exit;
  const program = new Command().exitOverride();
  register(program);
  await program.parseAsync(["reembed", "--port", String(opts.httpPort ?? 18726), "--ops-port", "18725", ...(opts.agent ? ["--agent", opts.agent] : []), ...(opts.dryRun ? ["--dry-run"] : [])], { from: "user" });
  return { logs, requests, targetOptions, code: process.exitCode };
}

test("ckLY explicit CLI ports reach target resolution", async () => {
  const result = await run({ dryRun: true });
  expect(result.targetOptions).toMatchObject({ port: "18726", opsPort: "18725" });
  expect(result.requests.some(request => request.port === "18725")).toBe(true);
});

test("ckMA newline and literal backslash stamps retain separate counts", async () => {
  const { logs } = await run({ stamps: ["old\nmodel", "old\\nmodel"] });
  const reasons = logs.filter(line => line.includes("row(s)"));
  expect(reasons).toHaveLength(2);
  expect(reasons[0]).toContain("1 row(s) update unconfirmed: stored embeddingModel is old\\nmodel");
  expect(reasons[1]).toContain("1 row(s) update unconfirmed: stored embeddingModel is old\\\\nmodel");
});

test("ckME a successful PATCH with a failed read reports update unconfirmed", async () => {
  const { logs, requests, code } = await run({ readFailure: true });
  expect(requests.filter(request => request.method === "PATCH")).toHaveLength(1);
  expect(code).toBe(1);
  expect(logs.join("\n")).toContain("0 updated, 1 errors");
  expect(logs.join("\n")).toContain("update unconfirmed: stored model read failed: HTTP 500");
  expect(logs.join("\n")).not.toContain("not updated");
});

test("ckMU dry-run counts with an unavailable listener table without HTTP admin auth or PATCH", async () => {
  const { logs, requests, code } = await run({ dryRun: true, unavailable: true });
  expect(code).toBe(0);
  expect(logs.join("\n")).toContain("Read 1 memories");
  expect(logs.join("\n")).toContain("Memories to re-embed: 1");
  expect(requests.filter(request => request.method === "PATCH")).toEqual([]);
  expect(requests.filter(request => request.port === "18726" && request.auth !== null)).toEqual([]);
});

for (const agent of [undefined, "owner"] as Array<string | undefined>) {
  test(`ckMo retry preserves ports and agent ${JSON.stringify(agent)}`, async () => {
    const { logs } = await run({ agent });
    const reason = logs.find(line => line.includes("row(s)"))!;
    expect(reason).toContain("--port 18726 --ops-port 18725");
    if (agent?.includes("\n")) {
      expect(reason).toContain("same agent ID");
      expect(reason).not.toContain("`flair reembed");
    } else {
      const command = reason.slice(reason.indexOf("`flair reembed") + 1, reason.lastIndexOf("`"));
      const parsed = spawnSync("/bin/sh", [shellScript(`flair() { printf '%s\\n' "$@"; }; ${command}`)], { encoding: "utf8", timeout: 5000 });
      expect(parsed.status).toBe(0);
      expect(parsed.stdout.trim().split("\n")).toEqual(["reembed", ...(agent ? ["--agent", agent] : []), "--port", "18726", "--ops-port", "18725"]);
    }
  }, 10_000);
}

test("ckMo an invalid agent id is refused (#3136)", async () => {
  for (const agent of ["owner' $HOME; `false`", "owner\ncontinued"]) {
    await expect(run({ agent })).rejects.toThrow("EXIT:1");
  }
}, 10_000);

test("ckMo retry retains HTTP port 80", async () => {
  const { logs, requests } = await run({ agent: "owner", httpPort: 80 });
  expect(requests.some(request => request.port === "")).toBe(true);
  expect(logs.find(line => line.includes("row(s)"))).toContain("--port 80 --ops-port 18725");
});

for (const mode of ["all", "agent"]) {
  test(`ckMv ${mode} summary drains through a backpressured pipe`, async () => {
    ensureCliBuild();
    const key = join(tempDir("reembed-drain-3135-"), "owner.key");
    writeFileSync(key, nacl.sign.keyPair().secretKey.slice(0, 32), { mode: 0o600 });
    const child = spawn(nodeBin(), [join(import.meta.dirname, "../helpers/reembed-drain-child.mjs"), mode, key], {
      env: { ...process.env, FLAIR_ADMIN_PASS: "test", FLAIR_UNIT_TEST: "1" }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
    });
    child.stdout.pause();
    const timer = setTimeout(() => child.stdout.resume(), 200);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }).finally(() => clearTimeout(timer));
    expect(code, stderr).toBe(1);
    expect(stdout.split("\n").filter(line => line.includes("row(s) update unconfirmed:"))).toHaveLength(128);
    expect(stdout).toContain("END-127");
    expect(stdout).toEndWith("--ops-port 18725` after fixing the cause\n");
  }, 30_000);
}
