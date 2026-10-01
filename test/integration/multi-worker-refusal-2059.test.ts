// multi-worker-refusal-2059.test.ts — REAL Harper, two workers, refusal active.
//
// flair#2059 (S0 of #2052): with more than one Harper worker the instance refuses
// to serve until the multi-worker readiness work lands. The refusal runs ahead of
// the handlers on the default chain and on each urlPath mount — proved through a
// real Harper, not by invoking a captured middleware callback:
//
//   - a default REST route answers the one named 503;
//   - a MOUNTED route flair registers (a /.well-known discovery mount, its own
//     dispatch chain) answers the same 503;
//   - the OAuth plugin's own /.well-known/jwks.json mount answers the same 503,
//     so the guard is pulled into that chain too;
//   - a disallowed method answers 503, not the method allowlist's 405, so the
//     guard runs ahead of the allowlist;
//   - /Health stays reachable and reports the refusal;
//   - the doctor discovery path (probeFlairHealth) observes the /Health refusal response.
//
// The multi-worker case is gated to Linux below.

import { describe, test, beforeAll, afterAll, expect } from "bun:test";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { probeFlairHealth } from "../../src/lib/doctor-run.js";

// Enable MCP OAuth so the test exercises the plugin's jwks response.
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

describe("one worker serves (control)", () => {
  let harper: HarperInstance;
  beforeAll(async () => {
    harper = await startHarper();
  }, 240_000);
  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test(
    "a default route, the mounted discovery route and the plugin's jwks route serve on one worker",
    async () => {
      const base = harper.httpURL.replace(/\/$/, "");
      // The mounted discovery route is reachable and answers its document.
      const wellKnown = await fetch(`${base}/.well-known/oauth-protected-resource`);
      expect(wellKnown.status).toBe(200);
      // The OAuth plugin's own mount is enabled and serves here, so the
      // two-worker case below proves the guard covers this same route.
      const jwks = await fetch(`${base}/.well-known/jwks.json`);
      expect(jwks.status).toBe(200);
      // A default-chain route serves too: the admin credential reaches
      // /Presence (200), so the guard stepped aside rather than refusing.
      const presence = await fetch(`${base}/Presence`, {
        headers: { Authorization: basicHeader(harper) },
      });
      expect(presence.status).toBe(200);
    },
    240_000,
  );
});

describe("multi-worker refusal enforced before dispatch (real Harper, 2 workers)", () => {
  let harper: HarperInstance;
  beforeAll(async () => {
    // multiWorkerUnsafe: false — boot a REFUSED instance (no opt-in).
    harper = await startHarper({ threads: 2, multiWorkerUnsafe: false });
  }, 240_000);
  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test.skipIf(process.platform !== "linux")(
    "refuses a default route, a mounted route, the plugin's jwks route, a disallowed method and /Health, and the doctor probe observes it",
    async () => {
      const base = harper.httpURL.replace(/\/$/, "");
      // Right after boot a worker can still be settling; retry a request that
      // fails at the transport level (bounded, not a poll of the state).
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

      // A default REST route (served by the default dispatch chain).
      const presence = await get("/Presence");
      expect(presence.status).toBe(503);
      expect(((await presence.json()) as { error?: string }).error).toBe("multi_worker_unsupported");

      // A MOUNTED route flair registers: its own urlPath dispatch chain must
      // pull the guard in via the `after` its mount declares.
      const wellKnown = await get("/.well-known/oauth-protected-resource");
      expect(wellKnown.status).toBe(503);
      expect(((await wellKnown.json()) as { error?: string }).error).toBe("multi_worker_unsupported");

      // The OAuth plugin's OWN mount: it registers /.well-known/jwks.json
      // without declaring the guard, so the pass-through entry oauth-wellknown.ts
      // registers at the same path pulls the guard into that chain. This route
      // answers 200 on the one-worker control above, so this 503 is the guard
      // refusing the same enabled plugin route.
      const jwks = await get("/.well-known/jwks.json");
      expect(jwks.status).toBe(503);
      expect(((await jwks.json()) as { error?: string }).error).toBe("multi_worker_unsupported");

      // A disallowed method: the guard runs ahead of the method allowlist, so
      // this is 503, never the allowlist's 405. (A TRACE response carries no
      // body, so only the status is asserted.)
      const trace = await get("/Memory", { method: "TRACE" });
      expect(trace.status).toBe(503);

      // A protected route with NO credential is 503, not a 401/403: the guard
      // runs before Harper's `authentication` and before auth-middleware's
      // credential read on this default-chain route.
      const memory = await get("/Memory");
      expect(memory.status).toBe(503);

      // /Health stays reachable and reports the refusal.
      const health = await get("/Health");
      expect(health.status).toBe(503);
      const healthBody = (await health.json()) as { ok?: boolean; multiWorker?: { state?: string } };
      expect(healthBody.ok).toBe(false);
      expect(healthBody.multiWorker?.state).toBe("refused");

      // The doctor discovery path reads the /Health refusal response.
      const probe = await probeFlairHealth(`${base}/Health`);
      expect(probe.reaching).toBe(true);
      expect(probe.observation?.kind).toBe("refused");
    },
    240_000,
  );
});
