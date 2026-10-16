/** Commander actions with the real credential-file resolver and a fake ops transport. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { program } from "../../src/cli.ts";
import { REQUIRED_PACKAGE_FILES } from "../../src/deploy.ts";

const dir = mkdtempSync(join(tmpdir(), "flair-checkpoint-actions-unit-"));
const password = join(dir, "password");
const checkpoint = join(dir, "checkpoint.json");
const target = "https://checkpoint.example.invalid";
const credential = "checkpoint-fixture-password";
writeFileSync(password, credential, { mode: 0o600 });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
let rows = [{ id: "memory-a", durability: "permanent" }, { id: "memory-b", durability: "standard" }];

async function action(args: string[], afterCount?: number, inheritedUser = "admin") {
  let countReads = 0;
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalUser = process.env.FABRIC_USER;
  const originalOps = process.env.FLAIR_OPS_TARGET;
  const output: string[] = [];
  const exited = Symbol("exit");
  let code = 0;
  process.env.FABRIC_USER = inheritedUser;
  delete process.env.FLAIR_OPS_TARGET;
  globalThis.fetch = (async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body, auth: new Headers(init?.headers).get("Authorization") });
    if (body.operation === "describe_table") return Response.json({ record_count: ++countReads > 1 ? afterCount ?? rows.length : rows.length });
    return Response.json(rows);
  }) as typeof fetch;
  process.exit = ((n?: number) => { code = n ?? 0; throw exited; }) as typeof process.exit;
  console.log = console.error = (...args: unknown[]) => { output.push(args.join(" ")); };
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
    if (originalOps === undefined) delete process.env.FLAIR_OPS_TARGET;
    else process.env.FLAIR_OPS_TARGET = originalOps;
  }
  return { code, output: output.join("\n") };
}

function memoryArgs(command: string, path = checkpoint) {
  return ["memory", command, "--target", target, "--fabric-user", "admin", "--fabric-password-file", password, "--checkpoint", path];
}

function projection() {
  expect(calls.length).toBeGreaterThan(0);
  const queries = calls.filter((call) => call.body.operation === "sql");
  expect(queries.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.url).toBe("https://checkpoint.example.invalid:9925/");
    expect(call.auth).toBe(`Basic ${Buffer.from(`admin:${credential}`).toString("base64")}`);
  }
  for (const call of queries) {
    expect(call.body).toEqual({ operation: "sql", sql: "SELECT id, durability FROM flair.Memory ORDER BY id LIMIT 10000" });
  }
}

function deployArgs(path: string) {
  const root = join(dir, "package");
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
  return ["deploy", "--target", target, "--fabric-password-file", password, "--package-root", root,
    "--no-verify", "--no-fleet-verify", "--memory-checkpoint", path];
}

describe("Memory checkpoint Commander actions", () => {
  test("checkpoint and verify use admin password-file credentials despite a different FABRIC_USER", async () => {
    calls.length = 0;
    const saved = await action(memoryArgs("checkpoint"), undefined, "cluster-admin");
    expect(saved.code).toBe(0);
    expect(saved.output).toContain("Checkpoint written");
    expect(JSON.parse(readFileSync(checkpoint, "utf8")).ids).toEqual(["memory-a", "memory-b"]);
    projection();
    calls.length = 0;
    const verified = await action(memoryArgs("verify"), undefined, "cluster-admin");
    expect(verified.code).toBe(0);
    expect(verified.output).toContain("VERIFIED");
    projection();
  });

  test("a changed final count reports unknown without writing a checkpoint", async () => {
    const path = join(dir, "drifting.json");
    const result = await action(memoryArgs("checkpoint", path), rows.length + 1);
    expect(result.code).toBe(3);
    expect(result.output).toContain("unknown: writes during checkpoint");
    expect(existsSync(path)).toBe(false);
  });

  test("verify action returns exit 2 for a missing checkpointed id", async () => {
    const original = rows;
    rows = rows.slice(0, 1);
    try {
      const result = await action(memoryArgs("verify"));
      expect(result.code).toBe(2);
      expect(result.output).toContain("memory-b");
    } finally { rows = original; }
  });

  test("deploy action checks the saved checkpoint through the ops resolver", async () => {
    calls.length = 0;
    const result = await action(deployArgs(checkpoint));
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Memory id/tier check: verified");
    projection();
  }, 30_000);

  test("malformed checkpoint bytes do not appear in verify or deploy output", async () => {
    const path = join(dir, "malformed.json");
    const marker = "SECRET_MARKER_MALFORMED_CHECKPOINT";
    writeFileSync(path, `{"secret":"${marker}", broken`);
    const verify = await action(memoryArgs("verify", path));
    expect(verify.code).toBe(3);
    expect(verify.output).toContain("checkpoint is not valid JSON");
    expect(verify.output).not.toContain(marker);
    const deploy = await action(deployArgs(path));
    expect(deploy.code, deploy.output).toBe(0);
    expect(deploy.output).toContain("Memory id/tier check: unknown");
    expect(deploy.output).not.toContain(marker);
  }, 30_000);
});
