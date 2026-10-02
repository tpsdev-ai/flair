import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyKeysDir, makeReadInstanceIds } from "../../src/commands/keys.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const servers: Bun.Server<undefined>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
const live = "flair_1111aaaa";
const candidate = "flair_deadbeef";

function listeners(targetId = live, redirect = false) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const ops = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/HealthDetail") return Response.json({ federation: { instance: { id: live } } });
        const body = await request.json();
        return Response.json(body.sql.includes("flair.Instance") ? [{ id: live }] : []);
      },
    });
    servers.push(ops);
    try {
      const target = Bun.serve({
        hostname: "127.0.0.1", port: ops.port! + 1,
        fetch(request) {
          if (new URL(request.url).pathname !== "/HealthDetail") return new Response(null, { status: 404 });
          return redirect ? Response.redirect(`${ops.url}HealthDetail`) : Response.json({ federation: { instance: { id: targetId } } });
        },
      });
      servers.push(target);
      return { ops, target };
    } catch (error) {
      ops.stop(true);
      servers.pop();
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("Could not bind adjacent fixture ports");
}

async function classify(ops: Bun.Server<undefined>, target: { url: URL; port?: number }) {
  const keysDir = tempDir("flair-target-binding-loopback-");
  for (const id of [live, candidate]) writeFileSync(join(keysDir, `${id}.key`), Buffer.alloc(60, 42));
  const baseUrl = target.url.origin;
  return classifyKeysDir(keysDir, baseUrl, makeReadInstanceIds({
    baseUrl, port: target.port,
    resolveHttpPort: () => target.port!, resolveOpsPort: () => ops.port!,
    resolveAdminPass: () => "fixture-password",
  }));
}

test("absent HTTP target beside a responding ops listener labels no candidate", async () => {
  const { ops, target } = listeners();
  const response = await fetch(ops.url, { method: "POST", body: JSON.stringify({ sql: "SELECT id FROM flair.Instance" }) });
  expect(await response.json()).toEqual([{ id: live }]);
  const endpoint = { url: target.url, port: target.port };
  target.stop(true);
  const result = await classify(ops, endpoint);
  expect(result.entries.map(entry => entry.class)).toEqual(["unidentified", "unidentified"]);
  for (const entry of result.entries) expect(entry.reason).toContain("target identity unreadable");
});

test("matching HTTP and ops identities label the unreferenced file as a candidate", async () => {
  const { ops, target } = listeners();
  const result = await classify(ops, target);
  expect(Object.fromEntries(result.entries.map(entry => [entry.agentId, entry.class]))).toEqual({
    [live]: "keep", [candidate]: "orphan-candidate",
  });
});

test("mismatched HTTP and ops identities leave all node-shaped files unidentified", async () => {
  const { ops, target } = listeners(candidate);
  const result = await classify(ops, target);
  expect(result.entries.every(entry => entry.class === "unidentified")).toBe(true);
  expect(result.entries[0].reason).toContain("target/ops Instance id mismatch");
});

test("HTTP identity redirects cannot bind an ops listener to the target", async () => {
  const { ops, target } = listeners(live, true);
  const result = await classify(ops, target);
  expect(result.entries.every(entry => entry.class === "unidentified")).toBe(true);
  expect(result.entries[0].reason).toContain("target identity unreadable");
});
