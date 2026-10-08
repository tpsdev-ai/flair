import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import nacl from "tweetnacl";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureCliBuild } from "../helpers/build-cli-once.js";

const CLI = join(resolve(import.meta.dir, "../.."), "dist", "cli.js");
const BASELINE_VERSION = "0.59.0";
const AGENT_ID = "reembed-compat-agent";
const MEMORY_ID = "reembed-compat-memory";
const VECTOR = Array.from({ length: 768 }, (_, i) => ((i % 7) + 1) / 1000);

function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key) && key !== "GITHUB_TOKEN" && key !== "NPM_TOKEN",
  ));
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, timeout, killSignal: "SIGKILL" });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolveRun({ code, signal, out }));
  });
}

describe("HEAD reembed against published Flair 0.59.0 [flair#2337]", () => {
  let baselineDir: string;
  let home: string;
  let baseline: HarperInstance | undefined;
  let proxy: Server | undefined;
  let port: number;
  let patches = 0;
  let healthReads = 0;

  async function op(body: Record<string, unknown>): Promise<any> {
    const inst = baseline!;
    const res = await fetch(`${inst.opsURL}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${inst.admin.username}:${inst.admin.password}`).toString("base64"),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json();
  }

  async function readMemory(): Promise<any> {
    const rows = await op({ operation: "search_by_id", database: "flair", table: "Memory", ids: [MEMORY_ID], get_attributes: ["*"] });
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  function runReembed(args: string[]): Promise<{ code: number | null; signal: string | null; out: string }> {
    return new Promise((resolveRun, reject) => {
      const child = spawn("node", [CLI, "reembed", "--port", String(port), ...args], {
        cwd: baselineDir,
        env: {
          ...cleanEnv(),
          HOME: home,
          FLAIR_OPS_PORT: new URL(baseline!.opsURL).port,
          FLAIR_ADMIN_USER: baseline!.admin.username,
          FLAIR_ADMIN_PASS: baseline!.admin.password,
        },
        timeout: 60_000,
        killSignal: "SIGKILL",
      });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { out += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolveRun({ code, signal, out }));
    });
  }

  beforeAll(async () => {
    ensureCliBuild();
    expect(process.env.HARPER_HTTP_URL).toBeUndefined();
    baselineDir = await mkdtemp(join(tmpdir(), "flair-reembed-baseline-"));
    home = join(baselineDir, "home");
    await mkdir(join(home, ".flair", "keys"), { recursive: true });
    const env = { ...cleanEnv(), HOME: home };
    for (const args of [
      ["init", "-y"],
      ["install", `@tpsdev-ai/flair@${BASELINE_VERSION}`],
      ...(process.platform === "linux" ? [["install", "--no-save", "@node-llama-cpp/linux-x64@3"]] : []),
    ]) {
      const result = await run("npm", args, baselineDir, env, 300_000);
      expect(result.signal, result.out).toBeNull();
      expect(result.code, result.out).toBe(0);
    }
    const pkgDir = join(baselineDir, "node_modules", "@tpsdev-ai", "flair");
    expect(JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")).version).toBe(BASELINE_VERSION);
    baseline = await startHarper({ cwd: pkgDir, harperBinDir: baselineDir });
    expect(baseline.external).toBe(false);
    const healthDeadline = Date.now() + 120_000;
    let response: Response;
    do {
      response = await fetch(`${baseline.httpURL}/Health`, { signal: AbortSignal.timeout(10_000) });
      if (response.status === 200) break;
      await response.body?.cancel();
      await Bun.sleep(250);
    } while (Date.now() < healthDeadline);
    expect(response.status, baseline.getLog?.() ?? "").toBe(200);
    const health = await response.json() as { version: string; capabilities?: string[] };
    expect(health.version).toBe(BASELINE_VERSION);
    expect(health.capabilities ?? []).not.toContain("memory-reembed-patch");

    const keys = nacl.sign.keyPair();
    await writeFile(join(home, ".flair", "keys", `${AGENT_ID}.key`), keys.secretKey.slice(0, 32), { mode: 0o600 });
    const createdAt = new Date().toISOString();
    const fixtures = [
      { table: "Agent", schema: "agent.graphql", row: { id: AGENT_ID, name: AGENT_ID, publicKey: Buffer.from(keys.publicKey).toString("base64"), createdAt } },
      { table: "Memory", schema: "memory.graphql", row: { id: MEMORY_ID, agentId: AGENT_ID, content: "Compatibility fixture", createdAt, embedding: VECTOR, embeddingModel: "nomic-embed-text-v1.5-Q4_K_M+searchprefix" } },
    ];
    for (const fixture of fixtures) {
      const schema = await readFile(join(pkgDir, "schemas", fixture.schema), "utf8");
      const fields = schema.match(new RegExp(`type ${fixture.table}\\b[^\\{]*\\{([\\s\\S]*?)\\n\\}`))?.[1];
      expect(fields).toBeDefined();
      for (const required of fields!.matchAll(/^\s*(\w+):\s*(?:\[[\w!]+\]|\w+)!/gm)) {
        expect(fixture.row).toHaveProperty(required[1]);
      }
      await op({ operation: "insert", database: "flair", table: fixture.table, records: [fixture.row] });
    }
    const stored = await readMemory();
    expect(stored.embedding).toEqual(VECTOR);
    expect(stored.embeddingModel).toBe(fixtures[1].row.embeddingModel);

    proxy = createServer((req, res) => {
      if (req.method === "PATCH") patches++;
      if (req.method === "GET" && req.url === "/Health") healthReads++;
      const upstream = request(new URL(req.url!, baseline!.httpURL), {
        method: req.method,
        headers: { ...req.headers, host: new URL(baseline!.httpURL).host },
        timeout: 10_000,
      }, (reply) => {
        res.writeHead(reply.statusCode!, reply.headers);
        reply.pipe(res);
      });
      upstream.on("timeout", () => upstream.destroy(new Error("baseline request timed out")));
      upstream.on("error", (err) => { res.destroy(err); });
      req.pipe(upstream);
    });
    await new Promise<void>((resolveListen, reject) => {
      const timer = setTimeout(() => reject(new Error("proxy bind timed out")), 5000);
      proxy!.once("error", (err) => { clearTimeout(timer); reject(err); });
      proxy!.listen(0, "127.0.0.1", () => { clearTimeout(timer); resolveListen(); });
    });
    port = (proxy.address() as AddressInfo).port;
  }, 1_200_000);

  afterAll(async () => {
    if (proxy) {
      proxy.closeAllConnections();
      await new Promise<void>((done) => proxy!.close(() => done()));
    }
    try {
      if (baseline) await stopHarper(baseline);
    } finally {
      if (baselineDir) await rm(baselineDir, { recursive: true, force: true });
    }
  }, 120_000);

  for (const mode of ["all agents", "--agent"]) {
    test(`${mode}: refusal, zero PATCHes and unchanged stored embedding`, async () => {
      const before = await readMemory();
      patches = 0;
      healthReads = 0;
      const result = await runReembed(mode === "--agent" ? ["--agent", AGENT_ID] : []);
      expect(result.signal, result.out).toBeNull();
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain("does not advertise the re-embed PATCH");
      expect(result.out).toContain(`server version ${BASELINE_VERSION}`);
      expect(result.out).toContain("Restart or upgrade the server, then re-run `flair reembed`");
      expect(healthReads).toBe(1);
      expect(patches).toBe(0);
      const after = await readMemory();
      expect(after.embedding).toEqual(before.embedding);
      expect(after.embeddingModel).toBe(before.embeddingModel);
      console.log(`${mode}: Flair ${BASELINE_VERSION}; exit 1; remedy present; PATCHes=${patches}; stored embedding and model unchanged`);
    }, 90_000);
  }
});
