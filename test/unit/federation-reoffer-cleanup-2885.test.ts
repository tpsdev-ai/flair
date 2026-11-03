import { expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto";
import { retryEntryKey } from "../../src/lib/federation-retry-row";

it("an assertion failure drains the original cleanup before the next receiver reset", async () => {
  const pauseDir = fs.mkdtempSync(join(tmpdir(), "flair-cleanup-2885-"));
  const injected = new Error("injected assertion failure");
  const cases = new Map<string, () => Promise<void>>();
  const afterEachHooks: Array<() => Promise<void>> = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  const rows = new Map<string, unknown>();
  const probes: string[] = [];
  let nextTimer = 0;
  let now = 0;
  let preCommitReleased = false;
  let scenarioError: unknown;
  let scenarioSettled = false;
  let injections = 0;
  const clock = {
    setTimeout(callback: () => void, ms: number) {
      const id = ++nextTimer;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    async drain() {
      for (let i = 0; i < 100; i++) await Promise.resolve();
    },
    async advance(ms: number, stop = () => false) {
      const end = now + ms;
      await this.drain();
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await this.drain();
        if (stop()) return;
      }
      now = end;
      await this.drain();
    },
  };
  const writeMarker = (path: string, value: string) => {
    if (path === join(pauseDir, "go.federation-merge-commit")) preCommitReleased = true;
    fs.writeFileSync(path, value);
  };
  const bindings = {
    afterAll() {},
    afterEach(fn: () => Promise<void>) { afterEachHooks.push(fn); },
    beforeAll() {},
    beforeEach() {},
    describe(_title: string, fn: () => void) { fn(); },
    expect(value: unknown, message?: string) {
      if (message === "cleanup resolved while the merge was unfinished") {
        injections++;
        throw injected;
      }
      return expect(value, message);
    },
    it(title: string, fn: () => Promise<void>) { cases.set(title, fn); },
    mock() {},
    randomBytes,
    existsSync: fs.existsSync,
    mkdtempSync: fs.mkdtempSync,
    readFileSync: fs.readFileSync,
    rmSync: fs.rmSync,
    writeFileSync: writeMarker,
    tmpdir,
    join,
    nacl,
    signBodyFresh,
    retryEntryKey,
    HARPER_STOP_BUDGET_MS: 0,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    async fetch(_url: string, init: RequestInit) {
      const record = JSON.parse(String(init.body)).records[0];
      const id = record.id;
      if (!String(record.data.content).startsWith("cleanup-probe-")) {
        for (const point of ["federation-merge", "federation-merge-commit"]) {
          writeMarker(join(pauseDir, `claimed.${point}`), "");
          writeMarker(join(pauseDir, `paused.${point}`), "");
          writeMarker(join(pauseDir, `released.${point}`), "go");
        }
        return Response.json({ indeterminate: [{ table: "Memory", id }] });
      }
      probes.push(id);
      if (!preCommitReleased) return Response.json({ merged: 0, skippedReasons: { merge_target_busy: 1 } });
      rows.set(id, record.data);
      return Response.json({ merged: 1 });
    },
  };
  const source = fs.readFileSync(join(import.meta.dir, "../integration/federation-reoffer-busy-2797.test.ts"), "utf8");
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^import .*;$/gm, ""));
  const load = new Function(...Object.keys(bindings), `${compiled}\nreturn {
    initialize(dir) { pauseDir = dir; receiver = { httpURL: "http://receiver.invalid" }; },
    resetPauseMarkers, outstandingPushes, unconfirmedMergeIds
  };`);
  const suite = load(...Object.values(bindings)) as {
    initialize(dir: string): void;
    resetPauseMarkers(): Promise<void>;
    outstandingPushes: Set<Promise<Response>>;
    unconfirmedMergeIds: Set<string>;
  };
  suite.initialize(pauseDir);
  try {
    const scenario = cases.get("cleanup waits for a merge whose response was indeterminate");
    expect(scenario).toBeDefined();
    const running = scenario!().then(
      () => { scenarioSettled = true; },
      (error: unknown) => { scenarioError = error; scenarioSettled = true; },
    );
    await clock.advance(1_000, () => injections > 0);
    if (scenarioSettled) {
      writeMarker(join(pauseDir, "go.federation-merge-commit"), "");
    } else {
      expect(preCommitReleased).toBe(true);
      await clock.advance(250);
    }
    expect(scenarioSettled).toBe(true);
    await running;
    expect(injections).toBe(1);
    expect(scenarioError).toBe(injected);
    for (const hook of afterEachHooks) await hook();
    await suite.resetPauseMarkers();
    rows.clear();
    const probesAtReset = probes.length;
    await clock.advance(1_000);
    expect(probes.length, "a cleanup probe ran after the next receiver reset").toBe(probesAtReset);
    expect(rows.size).toBe(0);
    expect(suite.outstandingPushes.size).toBe(0);
    expect(suite.unconfirmedMergeIds.size).toBe(0);
    expect(timers.size).toBe(0);
  } finally {
    fs.rmSync(pauseDir, { recursive: true, force: true });
  }
});
