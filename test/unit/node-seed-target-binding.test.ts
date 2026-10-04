import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyKeysDir, makeReadInstanceIds } from "../../src/commands/keys.ts";
import { readNodeSeedAdvisory } from "../../src/commands/doctor.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const baseUrl = "http://127.0.0.1:29926";
const opsUrl = "http://127.0.0.1:29925/";
const live = "flair_1111aaaa";
const agent = "flair_2222bbbb";
const candidate = "flair_deadbeef";
const deps = {
  baseUrl, port: 29926,
  resolveHttpPort: () => 29926, resolveOpsPort: () => 29925,
  resolveAdminPass: () => "fixture-password",
};

function fixture(target: () => Response, instanceIds = [live]) {
  const requests: string[] = [];
  globalThis.fetch = (async (url, init) => {
    requests.push(String(url));
    if (String(url) === `${baseUrl}/HealthDetail`) {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toStartWith("Basic ");
      return target();
    }
    expect(String(url)).toBe(opsUrl);
    const sql = JSON.parse(String(init?.body)).sql;
    return Response.json(sql.includes("flair.Instance")
      ? instanceIds.map(id => ({ id })) : [{ id: agent }]);
  }) as typeof fetch;
  const keysDir = tempDir("flair-target-binding-");
  for (const id of [live, agent, candidate]) writeFileSync(join(keysDir, `${id}.key`), Buffer.alloc(60, 42));
  return { keysDir, requests };
}

test("absent HTTP target with responding adjacent ops leaves every node-shaped file unidentified", async () => {
  const { keysDir, requests } = fixture(() => { throw new Error("ECONNREFUSED"); });
  const ops = await fetch(opsUrl, { method: "POST", body: JSON.stringify({ sql: "SELECT id FROM flair.Instance" }) });
  expect(await ops.json()).toEqual([{ id: live }]);
  requests.length = 0;
  const result = await classifyKeysDir(keysDir, baseUrl, makeReadInstanceIds(deps));
  expect(result.entries.map(entry => entry.class)).toEqual(["unidentified", "unidentified", "unidentified"]);
  for (const entry of result.entries) expect(entry.reason).toContain("target identity unreadable");
  expect(requests).toEqual([`${baseUrl}/HealthDetail`]);
  const advisory = await readNodeSeedAdvisory({ ...deps, keysDir, nodeKeyIds: [live, agent, candidate] });
  expect(advisory).toContain("target identity unreadable");
  expect(advisory).toContain("remain unidentified");
});

test("matching HTTP and sole ops Instance id keeps unproven files unidentified", async () => {
  const { keysDir, requests } = fixture(() => Response.json({ federation: { instance: { id: live } } }));
  const result = await classifyKeysDir(keysDir, baseUrl, makeReadInstanceIds(deps));
  expect(Object.fromEntries(result.entries.map(entry => [entry.agentId, entry.class]))).toEqual({
    [live]: "keep", [agent]: "unidentified", [candidate]: "unidentified",
  });
  expect(requests).toEqual([`${baseUrl}/HealthDetail`, opsUrl, opsUrl]);
  expect(result.entries.find(entry => entry.agentId === candidate)?.reason).toContain("HTTP/ops Instance id matched");
});

test.each([
  ["missing", {}],
  ["absent", { federation: null }],
  ["empty", { federation: { instance: { id: " " } } }],
  ["unreadable", { federation: { instance: { unreadable: true, id: live } } }],
  ["multiple", { federation: { instance: { multiple: true, id: live } } }],
  ["hostname only", { hostname: "127.0.0.1", federation: { instance: null } }],
])("%s HTTP identity leaves every node-shaped file unidentified", async (_label, body) => {
  const { keysDir } = fixture(() => Response.json(body));
  const result = await classifyKeysDir(keysDir, baseUrl, makeReadInstanceIds(deps));
  expect(result.entries.every(entry => entry.class === "unidentified")).toBe(true);
  expect(result.entries[0].reason).toContain("target identity unreadable");
});

test.each([401, 503, 302])("HTTP %s cannot establish target identity", async status => {
  const { keysDir } = fixture(() => new Response(null, { status }));
  const result = await classifyKeysDir(keysDir, baseUrl, makeReadInstanceIds(deps));
  expect(result.entries.every(entry => entry.class === "unidentified")).toBe(true);
  expect(result.entries[0].reason).toContain(`HTTP ${status}`);
});

test.each([[candidate], [], [live, candidate]].map(ids => ({ ids })))("ops identity %j cannot bind to target", async ({ ids }) => {
  const { keysDir } = fixture(() => Response.json({ federation: { instance: { id: live } } }), ids);
  const result = await classifyKeysDir(keysDir, baseUrl, makeReadInstanceIds(deps));
  expect(result.entries.every(entry => entry.class === "unidentified")).toBe(true);
  expect(result.entries[0].reason).toContain(ids.length === 1 ? "target/ops Instance id mismatch" : "ops identity unreadable");
});
