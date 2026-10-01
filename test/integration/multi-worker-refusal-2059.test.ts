// multi-worker-refusal-2059.test.ts — REAL Harper, two workers, refusal active.
//
// flair#2059 (S0 of #2052): with more than one Harper worker the instance refuses
// to serve until the multi-worker readiness work lands. The refused state is
// enforced before dispatch on every route Flair serves — this proves it through a
// real Harper, not by invoking a captured middleware callback:
//
//   - a default REST route answers the one named 503;
//   - a MOUNTED route (the /.well-known discovery mount, its own dispatch chain)
//     answers the same 503, so the guard is pulled into a mounted chain;
//   - a disallowed method answers 503, not the method allowlist's 405, so the
//     guard runs ahead of the allowlist;
//   - /Health stays reachable and reports the refusal;
//   - the doctor discovery path (probeFlairHealth) observes the refused instance.
//
// Darwin forces one worker (Harper configValidator), so the refused two-worker
// instance cannot exist there and the case skips.

import { describe, test, beforeAll, afterAll, expect } from "bun:test";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { probeFlairHealth } from "../../src/lib/doctor-run.js";

describe("one worker serves the same routes (control)", () => {
  let harper: HarperInstance;
  beforeAll(async () => {
    harper = await startHarper();
  }, 240_000);
  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test(
    "a default route and the mounted route serve on one worker",
    async () => {
      const base = harper.httpURL.replace(/\/$/, "");
      // The mounted discovery route is reachable and answers its document.
      const wellKnown = await fetch(`${base}/.well-known/oauth-protected-resource`);
      expect(wellKnown.status).toBe(200);
      // The default chain serves too (no multi-worker refusal).
      const presence = await fetch(`${base}/Presence`);
      expect(presence.status).not.toBe(503);
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

  test.skipIf(process.platform === "darwin")(
    "refuses a default route, a mounted route, a disallowed method and /Health, and the doctor probe observes it",
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

      // A MOUNTED route: its own urlPath dispatch chain must pull the guard in.
      const wellKnown = await get("/.well-known/oauth-protected-resource");
      expect(wellKnown.status).toBe(503);
      expect(((await wellKnown.json()) as { error?: string }).error).toBe("multi_worker_unsupported");

      // A disallowed method: the guard runs ahead of the method allowlist, so
      // this is 503, never the allowlist's 405. (A TRACE response carries no
      // body, so only the status is asserted.)
      const trace = await get("/Memory", { method: "TRACE" });
      expect(trace.status).toBe(503);

      // A protected route with NO credential is 503, not a 401/403: the guard
      // runs before Harper's `authentication` and before any credential read.
      const memory = await get("/Memory");
      expect(memory.status).toBe(503);

      // /Health stays reachable and reports the refusal.
      const health = await get("/Health");
      expect(health.status).toBe(503);
      const healthBody = (await health.json()) as { ok?: boolean; multiWorker?: { state?: string } };
      expect(healthBody.ok).toBe(false);
      expect(healthBody.multiWorker?.state).toBe("refused");

      // The doctor discovery path sees the refused instance through a real
      // Harper, instead of skipping it as unobserved.
      const probe = await probeFlairHealth(`${base}/Health`);
      expect(probe.reaching).toBe(true);
      expect(probe.observation?.kind).toBe("refused");
    },
    240_000,
  );
});
