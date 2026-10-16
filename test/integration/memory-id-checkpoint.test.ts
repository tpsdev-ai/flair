/** Memory checkpoint commands and paging against Harper's operations API. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { REQUIRED_PACKAGE_FILES } from "../../src/deploy.js";
import {
  buildCheckpoint, buildOpsPost, readCheckpointFile, readMemoryRowsPaged,
  verifyCheckpoint, writeCheckpointFile,
} from "../../src/memory-id-checkpoint.js";

let harper: HarperInstance;
let dir: string;
let passwordFile: string;
let checkpointFile: string;
let served: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
const requests: Record<string, unknown>[] = [];
const secret = "SECRET_MARKER_MALFORMED_CHECKPOINT";
const cliPath = resolve("dist/cli.js");
const seed = [
  { id: "a-old", durability: "permanent" },
  { id: "b'quoted", durability: "persistent" },
  { id: "c-drop", durability: "standard" },
  { id: "d-keep", durability: "ephemeral" },
];

async function insert(id: string, durability = "standard") {
  const post = buildOpsPost(harper.opsURL, harper.admin.username, harper.admin.password);
  await post({ operation: "insert", database: "flair", table: "Memory", records: [{
    id, agentId: "checkpoint-agent", content: "fixture content", createdAt: "1960-01-01T00:00:00.000Z", durability,
  }] });
}

async function remove(id: string) {
  const post = buildOpsPost(harper.opsURL, harper.admin.username, harper.admin.password);
  await post({ operation: "delete", database: "flair", table: "Memory", ids: [id] });
}

async function command(args: string[]) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(FLAIR_|FABRIC_|HARPER_|HDB_)/.test(key)) env[key] = value;
  }
  const child = Bun.spawn(["node", cliPath, ...args], {
    env: { ...env, HOME: dir, USERPROFILE: dir, FABRIC_USER: harper.admin.username },
    stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { code, output: stdout + stderr };
}

function memoryArgs(action: string, path = checkpointFile, target = served.url.origin, opsTarget?: string) {
  return ["memory", action, "--target", target, "--fabric-password-file", passwordFile,
    ...(path === checkpointFile ? [] : ["--checkpoint", path]),
    ...(opsTarget ? ["--ops-target", opsTarget] : [])];
}

function assertProjection() {
  const queries = requests.filter((body) => body.operation === "sql");
  expect(queries.length).toBeGreaterThan(0);
  for (const body of queries) {
    expect(body.sql).toMatch(/^SELECT id, durability FROM flair\.Memory(?: WHERE id > '(?:[^']|'')*')? ORDER BY id LIMIT \d+$/);
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "flair-checkpoint-actions-"));
  harper = await startHarper();
  passwordFile = join(dir, "password");
  checkpointFile = join(dir, ".flair", "memory-id-checkpoint.json");
  writeFileSync(passwordFile, harper.admin.password, { mode: 0o600 });
  for (const row of seed) await insert(row.id, row.durability);
  for (let attempt = 0; attempt < 20; attempt++) {
    proxy = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const body = await req.json() as Record<string, unknown>;
        requests.push(body);
        return fetch(harper.opsURL, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: req.headers.get("Authorization") ?? "" },
          body: JSON.stringify(body),
        });
      },
    });
    try {
      served = Bun.serve({ hostname: "127.0.0.1", port: Number(proxy.port) + 1,
        fetch() { return new Response("served API must not receive operations", { status: 400 }); },
      });
      break;
    } catch {
      await proxy.stop(true);
    }
  }
  if (!served) throw new Error("could not reserve adjacent served/ops ports");
}, 180_000);

afterAll(async () => {
  if (served) await served.stop(true);
  if (proxy) await proxy.stop(true);
  if (harper) await stopHarper(harper);
  if (dir) rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe("Memory checkpoint actions and real Harper", () => {
  test("documented served-target commands resolve the separate ops port and password file", async () => {
    requests.length = 0;
    const checkpoint = await command(memoryArgs("checkpoint"));
    expect(checkpoint.code, checkpoint.output).toBe(0);
    expect(checkpoint.output).toContain("Checkpoint written");
    const read = readCheckpointFile(checkpointFile);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") throw new Error("checkpoint missing");
    for (const row of seed) expect(read.checkpoint.ids).toContain(row.id);
    expect(read.checkpoint.node).toBe(proxy.url.origin);
    expect(readFileSync(checkpointFile, "utf8")).not.toContain("fixture content");
    const result = await command(memoryArgs("verify"));
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("VERIFIED");
    expect(result.output).toContain("no tier-count drop");
    assertProjection();
    expect(statSync(checkpointFile).mode & 0o777).toBe(0o600);
    expect(statSync(passwordFile).mode & 0o777).toBe(0o600);
  }, 60_000);

  test("ops-target override reaches a nonadjacent real Harper port", async () => {
    const path = join(dir, "override.json");
    const checkpoint = await command(memoryArgs("checkpoint", path, harper.httpURL, harper.opsURL));
    expect(checkpoint.code, checkpoint.output).toBe(0);
    const result = await command(memoryArgs("verify", path, harper.httpURL, harper.opsURL));
    expect(result.code, result.output).toBe(0);
  }, 60_000);

  test("small keyset pages include pre-epoch rows and return only projected fields", async () => {
    const post = buildOpsPost(proxy.url.origin, harper.admin.username, harper.admin.password);
    let pages = 0;
    requests.length = 0;
    const rows = await readMemoryRowsPaged(async (body) => {
      const result = await post(body);
      if (body.operation === "sql") {
        pages++;
        expect(Array.isArray(result)).toBe(true);
        for (const row of result as Record<string, unknown>[]) expect(Object.keys(row).sort()).toEqual(["durability", "id"]);
      }
      return result;
    }, { pageSize: 2 });
    expect(pages).toBeGreaterThan(1);
    for (const row of seed) expect(rows.map((r) => r.id)).toContain(row.id);
    assertProjection();
  }, 60_000);

  test("delete of a read id plus insertion after the cursor between pages yields unknown", async () => {
    const post = buildOpsPost(proxy.url.origin, harper.admin.username, harper.admin.password);
    let changed = false;
    try {
      const result = await verifyCheckpoint({
        checkpoint: buildCheckpoint({ node: served.url.origin, at: new Date().toISOString(), rows: seed }),
        target: served.url.origin, pageSize: 2,
        opsPost: async (body) => {
          const response = await post(body);
          if (body.operation === "sql" && !changed) {
            changed = true;
            await remove("a-old");
            await insert("z-new");
          }
          return response;
        },
      });
      expect(changed).toBe(true);
      expect(result.outcome).toBe("unknown");
      expect(result.reason).toBe("writes during checkpoint");
    } finally {
      await remove("z-new");
      await insert("a-old", "permanent");
    }
  }, 60_000);

  test("verify action reports deletion with exit 2", async () => {
    await remove("c-drop");
    try {
      const result = await command(memoryArgs("verify"));
      expect(result.code, result.output).toBe(2);
      expect(result.output).toContain("c-drop");
      expect(result.output).toContain("INTEGRITY");
    } finally { await insert("c-drop"); }
  }, 60_000);

  test("deploy action reports a missing checkpointed id and exits 0", async () => {
    await remove("c-drop");
    try {
      const result = await command(deployArgs(checkpointFile));
      expect(result.output).toContain("Memory id/tier check: INTEGRITY FAILURE");
      expect(result.output).toContain("c-drop");
      expect(result.code, result.output).toBe(0);
    } finally { await insert("c-drop"); }
  }, 60_000);

  test("verify action returns unknown for an unreachable ops port", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const target = closed.url.origin;
    await closed.stop(true);
    const path = join(dir, "unreachable.json");
    writeCheckpointFile(path, buildCheckpoint({ node: target, at: new Date().toISOString(), rows: seed }));
    const result = await command(memoryArgs("verify", path, served.url.origin, target));
    expect(result.code, result.output).toBe(3);
    expect(result.output).toContain("UNKNOWN");
  }, 60_000);

  test("malformed checkpoint source is absent from verify and deploy output", async () => {
    const path = join(dir, "malformed.json");
    writeFileSync(path, `{"secret":"${secret}", broken`);
    const verify = await command(memoryArgs("verify", path));
    expect(verify.code, verify.output).toBe(3);
    expect(verify.output).toContain("checkpoint is not valid JSON");
    expect(verify.output).not.toContain(secret);
    const deploy = await command(deployArgs(path));
    expect(deploy.code, deploy.output).toBe(0);
    expect(deploy.output).toContain("Memory id/tier check: unknown");
    expect(deploy.output).not.toContain(secret);
  }, 60_000);

  test("deploy action checks an actual checkpoint through the ops resolver", async () => {
    requests.length = 0;
    const result = await command(deployArgs(checkpointFile));
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Memory id/tier check: verified");
    assertProjection();
  }, 60_000);
});

function deployArgs(path: string) {
  const root = join(dir, "deploy-package");
  for (const file of REQUIRED_PACKAGE_FILES) {
    const dest = join(root, file);
    mkdirSync(dirname(dest), { recursive: true });
    if (file.endsWith(".yaml")) writeFileSync(dest, "port: 9926\n");
    else mkdirSync(dest, { recursive: true });
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "checkpoint-fixture", version: "1.0.0", files: ["dist", "schemas", "config.yaml"] }));
  const bin = join(root, "node_modules/harper/dist/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "harper.js"), "process.exit(0);\n");
  return ["deploy", "--target", served.url.origin, "--fabric-password-file", passwordFile,
    "--package-root", root, "--no-verify", "--no-fleet-verify", "--memory-checkpoint", path];
}
