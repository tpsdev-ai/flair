import { describe, expect, test, mock, beforeEach } from "bun:test";

let syncImpl = async (_opts: any): Promise<{ pushed: number; skipped: number }> => ({
  pushed: 0,
  skipped: 0,
});
const mockSync = mock(async (opts: any) => syncImpl(opts));

mock.module("../../src/cli.js", () => ({
  runFederationSyncOnce: mockSync,
}));

import { runFederationWatch } from "../../src/cli.js";

describe("federation watch", () => {
  beforeEach(() => {
    mockSync.mockClear();
    syncImpl = async () => ({ pushed: 0, skipped: 0 });
  });

  test("watch runs sync on each interval tick", async () => {
    let calls = 0;
    syncImpl = async () => {
      calls++;
      return { pushed: 1, skipped: 0 };
    };

    const watchPromise = runFederationWatch({ interval: "0.1" });
    await new Promise((r) => setTimeout(r, 500));
    process.kill(process.pid, "SIGTERM");

    await watchPromise;

    expect(calls).toBeGreaterThanOrEqual(3);
    expect(mockSync).toHaveBeenCalledTimes(calls);
  });

  test("watch survives sync errors", async () => {
    let calls = 0;
    syncImpl = async () => {
      calls++;
      if (calls === 1) {
        throw new Error("boom");
      }
      return { pushed: 1, skipped: 0 };
    };

    const watchPromise = runFederationWatch({ interval: "0.1" });
    await new Promise((r) => setTimeout(r, 400));
    process.kill(process.pid, "SIGTERM");

    await watchPromise;

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("watch exits on SIGTERM", async () => {
    let calls = 0;
    syncImpl = async () => {
      calls++;
      return { pushed: 0, skipped: 0 };
    };

    const start = Date.now();
    const watchPromise = runFederationWatch({ interval: "10" });
    await new Promise((r) => setTimeout(r, 150));
    process.kill(process.pid, "SIGTERM");

    await watchPromise;
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
