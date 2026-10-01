import { describe, test, beforeAll, afterAll, expect } from "bun:test";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { probeFlairHealth } from "../../src/lib/doctor-run.js";

const priorOAuth = { flag: process.env.FLAIR_MCP_OAUTH, issuer: process.env.FLAIR_MCP_ISSUER };
beforeAll(() => {
  process.env.FLAIR_MCP_OAUTH = "true";
  process.env.FLAIR_MCP_ISSUER = "https://multi-worker-2059.flair.test";
});
afterAll(() => {
  if (priorOAuth.flag === undefined) delete process.env.FLAIR_MCP_OAUTH;
  else process.env.FLAIR_MCP_OAUTH = priorOAuth.flag;
  if (priorOAuth.issuer === undefined) delete process.env.FLAIR_MCP_ISSUER;
  else process.env.FLAIR_MCP_ISSUER = priorOAuth.issuer;
});

function basicHeader(harper: HarperInstance): string {
  return "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
}

describe("single-worker control", () => {
  let harper: HarperInstance;
  beforeAll(async () => {
    harper = await startHarper();
  }, 240_000);
  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test(
    "serves sampled routes",
    async () => {
      const base = harper.httpURL.replace(/\/$/, "");
      const wellKnown = await fetch(`${base}/.well-known/oauth-protected-resource`);
      expect(wellKnown.status).toBe(200);
      const jwks = await fetch(`${base}/.well-known/jwks.json`);
      expect(jwks.status).toBe(200);
      const presence = await fetch(`${base}/Presence`, {
        headers: { Authorization: basicHeader(harper) },
      });
      expect(presence.status).toBe(200);
    },
    240_000,
  );
});

describe("multi-worker refusal", () => {
  let harper: HarperInstance;
  beforeAll(async () => {
    harper = await startHarper({ threads: 2, multiWorkerUnsafe: false });
  }, 240_000);
  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test.skipIf(process.platform !== "linux")(
    "refuses sampled routes and reports Health",
    async () => {
      const base = harper.httpURL.replace(/\/$/, "");
      async function get(path: string, init?: RequestInit): Promise<Response> {
        let last: unknown;
        for (let i = 0; i < 20; i++) {
          try {
            return await fetch(`${base}${path}`, init);
          } catch (e) {
            last = e;
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        throw last;
      }

      const presence = await get("/Presence");
      expect(presence.status).toBe(503);
      expect(((await presence.json()) as { error?: string }).error).toBe("multi_worker_unsupported");

      const wellKnown = await get("/.well-known/oauth-protected-resource");
      expect(wellKnown.status).toBe(503);
      expect(((await wellKnown.json()) as { error?: string }).error).toBe("multi_worker_unsupported");

      const jwks = await get("/.well-known/jwks.json");
      expect(jwks.status).toBe(503);
      expect(((await jwks.json()) as { error?: string }).error).toBe("multi_worker_unsupported");

      const trace = await get("/Memory", { method: "TRACE" });
      expect(trace.status).toBe(503);

      const memory = await get("/Memory");
      expect(memory.status).toBe(503);

      const health = await get("/Health");
      expect(health.status).toBe(503);
      const healthBody = (await health.json()) as { ok?: boolean; multiWorker?: { state?: string } };
      expect(healthBody.ok).toBe(false);
      expect(healthBody.multiWorker?.state).toBe("refused");

      const probe = await probeFlairHealth(`${base}/Health`);
      expect(probe.reaching).toBe(true);
      expect(probe.observation?.kind).toBe("refused");
    },
    240_000,
  );
});
