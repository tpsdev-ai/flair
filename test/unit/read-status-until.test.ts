import { describe, expect, test } from "bun:test";
import { readStatusUntil, type PollClock } from "../helpers/read-status-until";

function fixture() {
  let time = 0;
  const timers = new Map<() => void, number>();
  const clock: PollClock = {
    now: () => time,
    sleep: async (ms) => { time += ms; },
    schedule: (callback, ms) => {
      timers.set(callback, time + ms);
      return () => { timers.delete(callback); };
    },
  };
  return {
    clock,
    timers,
    advance: (ms: number) => { time += ms; },
    fire: () => {
      for (const [callback, at] of timers) {
        time = at;
        timers.delete(callback);
        callback();
      }
    },
  };
}

describe("readStatusUntil", () => {
  test("rejects a late first response with the wanted status", async () => {
    const f = fixture();
    let signal: AbortSignal | undefined;
    const result = readStatusUntil(async (s) => {
      signal = s;
      f.advance(6_000);
      return 404;
    }, 404, 200, 5_000, f.clock);
    await expect(result).rejects.toThrow("deadline");
    expect(signal?.aborted).toBe(true);
    expect(f.timers.size).toBe(0);
  });

  test("rejects a poll crossing the deadline with the wanted status", async () => {
    const f = fixture();
    let calls = 0;
    const result = readStatusUntil(async () => {
      calls++;
      f.advance(calls === 1 ? 4_900 : 100);
      return calls === 1 ? 200 : 404;
    }, 404, 200, 5_000, f.clock);
    await expect(result).rejects.toThrow("deadline");
    expect(calls).toBe(2);
  });

  test("returns a 500 between 200s without another read", async () => {
    const f = fixture();
    const statuses = [200, 500, 200, 404];
    let calls = 0;
    expect(await readStatusUntil(async () => statuses[calls++], 404, 200, 5_000, f.clock)).toBe(500);
    expect(calls).toBe(2);
    expect(f.timers.size).toBe(0);
  });

  test("accepts the wanted status before the deadline", async () => {
    const f = fixture();
    let calls = 0;
    expect(await readStatusUntil(async () => {
      calls++;
      f.advance(calls === 1 ? 4_800 : 100);
      return calls === 1 ? 200 : 404;
    }, 404, 200, 5_000, f.clock)).toBe(404);
    expect(f.clock.now()).toBe(4_950);
  });

  test("does not start a read after a sleep reaches the deadline", async () => {
    const f = fixture();
    let calls = 0;
    await expect(readStatusUntil(async () => {
      calls++;
      f.advance(4_990);
      return 200;
    }, 404, 200, 5_000, f.clock)).rejects.toThrow("deadline");
    expect(calls).toBe(1);
    expect(f.clock.now()).toBe(5_000);
  });

  for (const stage of ["fetch", "body consumption"]) {
    test(`signals abort at the remaining deadline (${stage} simulation)`, async () => {
      const f = fixture();
      let calls = 0;
      let aborted = false;
      const result = readStatusUntil(async (signal) => {
        calls++;
        if (calls === 1) {
          f.advance(4_900);
          return 200;
        }
        if (stage === "body consumption") await Promise.resolve();
        return new Promise<number>((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          });
        });
      }, 404, 200, 5_000, f.clock);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(calls).toBe(2);
      expect([...f.timers.values()]).toEqual([5_000]);
      f.fire();
      await expect(result).rejects.toThrow("deadline");
      expect(aborted).toBe(true);
      expect(f.timers.size).toBe(0);
    });
  }

  test("clears the request timer when a read rejects", async () => {
    const f = fixture();
    const error = new Error("read failed");
    await expect(readStatusUntil(async () => { throw error; }, 404, 200, 5_000, f.clock)).rejects.toBe(error);
    expect(f.timers.size).toBe(0);
  });
});
