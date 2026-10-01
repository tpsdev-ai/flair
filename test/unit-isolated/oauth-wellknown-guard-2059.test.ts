import { describe, expect, it, mock } from "bun:test";

process.env.FLAIR_WELLKNOWN_NO_AUTOSTART = "1";

const httpEntries: Array<{ handler: unknown; options: any }> = [];
mock.module("harper", () => {
  const noop = () => {};
  const base: any = {
    server: {
      http: (handler: unknown, options: unknown) => {
        httpEntries.push({ handler, options });
      },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop, trace: noop },
    Resource: class {},
  };
  return new Proxy(base, { get: (t, p) => (p in t ? (t as any)[p] : noop) }) as any;
});

const { registerOAuthWellKnownRoutes } = await import("../../resources/oauth-wellknown.ts");
const { MULTI_WORKER_GUARD_HTTP_NAME, multiWorkerRequestGuard } = await import(
  "../../resources/multi-worker-guard.ts"
);
const { PRM_PATH, AS_METADATA_PATH, JWKS_PATH } = await import("../../resources/oauth-discovery.ts");

const WELL_KNOWN = [PRM_PATH, AS_METADATA_PATH, JWKS_PATH];

function mount(): void {
  httpEntries.length = 0;
  registerOAuthWellKnownRoutes({
    server: { http: (handler: any, options: any) => httpEntries.push({ handler, options }) },
  });
}

describe("well-known mounts", () => {
  it("registers guard mounts", () => {
    mount();
    for (const path of WELL_KNOWN) {
      const guardMount = httpEntries.find(
        (e) => e.options?.urlPath === path && e.handler === multiWorkerRequestGuard,
      );
      expect(guardMount, path).toBeDefined();
      expect(guardMount?.options?.runFirst, path).toBe(true);
    }
  });

  it("orders discovery handlers", () => {
    mount();
    for (const path of [PRM_PATH, AS_METADATA_PATH]) {
      const entry = httpEntries.find(
        (e) => e.options?.urlPath === path && e.handler !== multiWorkerRequestGuard,
      );
      expect(entry?.options?.after, path).toBe(MULTI_WORKER_GUARD_HTTP_NAME);
    }
  });

  it("lists mounted paths", () => {
    mount();
    const guardPaths = httpEntries
      .filter((e) => e.handler === multiWorkerRequestGuard)
      .map((e) => e.options?.urlPath)
      .sort();
    expect(guardPaths).toEqual([...WELL_KNOWN].sort());
    const docPaths = httpEntries
      .filter((e) => e.handler !== multiWorkerRequestGuard)
      .map((e) => e.options?.urlPath)
      .sort();
    expect(docPaths).toEqual([PRM_PATH, AS_METADATA_PATH].sort());
  });
});
