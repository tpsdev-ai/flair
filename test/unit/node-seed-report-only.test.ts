import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { applyKeyPrune, classifyKeysDir, program } from "../../src/cli.ts";
import { makeReadInstanceIds } from "../../src/commands/keys.ts";
import { readNodeSeedAdvisory } from "../../src/commands/doctor.ts";
import { probeInstanceIds } from "../../src/lib/instance-identity-row.ts";

const realFetch = globalThis.fetch;
const realLog = console.log;
const savedPass = process.env.FLAIR_ADMIN_PASS;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  if (savedPass === undefined) delete process.env.FLAIR_ADMIN_PASS;
  else process.env.FLAIR_ADMIN_PASS = savedPass;
});

test("--apply moves no node-shaped seed when two targets share a keys directory", async () => {
  const dir = tempDir("flair-seed-report-");
  const ids = ["flair_1111aaaa", "flair_2222bbbb"];
  const seed = Buffer.alloc(60, 42);
  for (const id of ids) writeFileSync(join(dir, `${id}.key`), seed);
  process.env.FLAIR_ADMIN_PASS = "fixture-password";
  const lines: string[] = [];
  console.log = (...args) => { lines.push(args.join(" ")); };
  for (const [index, port] of [19926, 29926].entries()) {
    globalThis.fetch = (async (_input, init) => {
      if (String(_input).endsWith("/HealthDetail")) return Response.json({ federation: { instance: { id: ids[index] } } });
      const body = JSON.parse(String(init?.body));
      return Response.json(body.sql.includes("flair.Instance") ? [{ id: ids[index] }] : []);
    }) as typeof fetch;
    await program.parseAsync(["keys", "prune", "--apply", "--keys-dir", dir,
      "--instance", `http://127.0.0.1:${port}`, "--port", String(port)], { from: "user" });
    for (const id of ids) expect(readFileSync(join(dir, `${id}.key`))).toEqual(seed);
    expect(existsSync(join(dir, ".pruned"))).toBe(false);
  }
  expect(lines.join("\n")).toContain("orphan candidate");
  expect(lines.join("\n")).toContain("ownership cannot be proven");
  // flair#2200: a seed with no owner record is named (sidecar path + remedy).
  expect(lines.join("\n")).toContain("no owner record");
});

test("apply rejects a node-shaped file even if supplied as stale or invalid", () => {
  const dir = tempDir("flair-seed-defense-");
  const name = "flair_deadbeef.key";
  writeFileSync(join(dir, name), Buffer.alloc(60, 42));
  for (const classification of ["stale", "invalid"] as const) {
    expect(applyKeyPrune(dir, [{ name, class: classification, reason: "fixture" }], "2026-10-02")).toEqual({ moved: [], skipped: [] });
    expect(existsSync(join(dir, name))).toBe(true);
  }
});

test("a registered Agent with a node-shaped id and missing .pub stays unidentified", async () => {
  const dir = tempDir("flair-seed-agent-");
  const id = "flair_deadbeef";
  writeFileSync(join(dir, `${id}.key`), Buffer.alloc(32, 7));
  const result = await classifyKeysDir(dir, "http://127.0.0.1:19926",
    async () => ({ state: "read", ids: [], agentIds: [id] }));
  expect(result.entries.map(entry => entry.class)).toEqual(["unidentified"]);
  expect(result.entries[0].reason).toContain("Agent");
  expect(applyKeyPrune(dir, result.entries, "2026-10-02")).toEqual({ moved: [], skipped: [] });
});

test("unknown Agent registration never licenses a candidate", async () => {
  const dir = tempDir("flair-seed-unknown-");
  writeFileSync(join(dir, "flair_deadbeef.key"), Buffer.alloc(60, 42));
  const result = await classifyKeysDir(dir, "http://127.0.0.1:19926",
    async () => ({ state: "read", ids: [] }));
  expect(result.entries.map(entry => entry.class)).toEqual(["unidentified"]);
});

test("matching HTTP port with mismatched ops override reads nothing", async () => {
  let reads = 0;
  const read = makeReadInstanceIds({
    baseUrl: "http://127.0.0.1:29926", port: 29926,
    resolveHttpPort: () => 29926, resolveOpsPort: () => 9925,
    resolveAdminPass: () => "fixture-password",
    probe: async () => { reads++; return { state: "read", ids: [] }; },
  });
  const result = await read();
  expect(result.state).toBe("unreadable");
  if (result.state === "unreadable") expect(result.reason).toContain("ops port");
  expect(reads).toBe(0);
});

test.each(["ops mismatch", "missing credential", "empty credential"])("doctor reports unreadable rows without a read or command: %s", async (failure) => {
  let reads = 0;
  const advisory = await readNodeSeedAdvisory({
    nodeKeyIds: ["flair_deadbeef"], keysDir: "/fixture/keys",
    baseUrl: "http://127.0.0.1:29926", port: 29926,
    resolveHttpPort: () => 29926,
    resolveOpsPort: () => failure === "ops mismatch" ? 9925 : 29925,
    resolveAdminPass: () => failure === "missing credential" ? undefined : failure === "empty credential" ? "" : "pw",
    probe: async () => { reads++; return { state: "read", ids: [], agentIds: [] }; },
  });
  expect(reads).toBe(0);
  expect(advisory).toContain("Instance reference check unavailable");
  expect(advisory).toContain(failure === "ops mismatch" ? "ops port" : "admin credential");
  expect(advisory).not.toContain("flair keys prune");
});

test.each([{}, [{}], [{ id: "" }], { results: "invalid" }])("malformed Agent rows keep node-shaped files unidentified: %j", async (body) => {
  const dir = tempDir("flair-seed-agent-read-");
  writeFileSync(join(dir, "flair_deadbeef.key"), Buffer.alloc(60, 42));
  const result = await classifyKeysDir(dir, "http://127.0.0.1:19926", () => probeInstanceIds({
    opsUrl: "http://127.0.0.1:19925", credentials: { user: "fixture", pass: "pw" },
    fetchImpl: (async (_url, init) => Response.json(
      JSON.parse(String(init?.body)).sql.includes("flair.Instance") ? [] : body,
    )) as typeof fetch,
  }));
  expect(result.entries.map(entry => entry.class)).toEqual(["unidentified"]);
  expect(result.entries[0].reason).toContain("Agent read returned no usable row list");
});

test("doctor excludes a registered Agent without .pub and reports only the other candidate", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push(String(url));
    if (String(url).endsWith("/HealthDetail")) return Response.json({ federation: { instance: { id: "flair_2222bbbb" } } });
    return Response.json(JSON.parse(String(init?.body)).sql.includes("flair.Instance") ? [{ id: "flair_2222bbbb" }] : [{ id: "flair_deadbeef" }]);
  }) as typeof fetch;
  const advisory = await readNodeSeedAdvisory({
    nodeKeyIds: ["flair_deadbeef", "flair_1111aaaa"], keysDir: "/fixture/keys",
    baseUrl: "http://127.0.0.1:29926", port: 29926,
    resolveHttpPort: () => 29926, resolveOpsPort: () => 29925, resolveAdminPass: () => "pw",
  });
  expect(requests).toEqual(["http://127.0.0.1:29926/HealthDetail", "http://127.0.0.1:29925/", "http://127.0.0.1:29925/"]);
  expect(advisory).toContain("1 orphan candidate(s)");
  expect(advisory).toContain("#2200");
  expect(advisory).not.toContain("flair keys prune");
});
