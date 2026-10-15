import { afterEach, describe, expect, it } from "bun:test";
import { WriteBackDeadlineError, WriteBackIndeterminateError, writeBackCommittedRow } from "../../resources/write-back";

const savedTransaction = (globalThis as any).transaction;
afterEach(() => { (globalThis as any).transaction = savedTransaction; });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(commitOutcome: () => Promise<void>) {
  let staged: any;
  let stored: any = null;
  let aborted = false;
  let submissions = 0;
  (globalThis as any).transaction = async (ctx: any, callback: () => Promise<any>) => {
    ctx.transaction = {
      async commit() {
        submissions++;
        await commitOutcome();
        stored = staged;
      },
    };
    try {
      return await callback();
    } catch (error) {
      staged = undefined;
      aborted = true;
      throw error;
    }
  };
  return {
    table: {
      async get() { return stored; },
      async put(row: any) { staged = row; },
    },
    stored: () => stored,
    aborted: () => aborted,
    submissions: () => submissions,
  };
}

const decision = { write: { id: "row", content: "merged" } };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("write-back deadline at commit submission", () => {
  it("awaits staged-write rollback before a pre-submission refusal", async () => {
    const f = fixture(async () => {});
    const paused = deferred();
    const release = deferred();
    let settled = false;
    const table = {
      ...f.table,
      async put(row: any) {
        await f.table.put(row);
        paused.resolve();
        await release.promise;
      },
    };
    const pending = writeBackCommittedRow(table, "row", () => decision, { label: "deadline", deadlineMs: 10 });
    const outcome = pending.catch((error) => { settled = true; return error; });
    await paused.promise;
    await sleep(30);
    expect(settled).toBe(false);
    release.resolve();
    expect(await outcome).toBeInstanceOf(WriteBackDeadlineError);
    expect(f.aborted()).toBe(true);
    expect(f.submissions()).toBe(0);
    expect(f.stored()).toBeNull();
  });

  for (const fail of [false, true]) {
    it(`awaits a submitted commit ${fail ? "failure as unknown" : "success"} past the timer`, async () => {
      const submitted = deferred();
      const release = deferred();
      const f = fixture(async () => {
        submitted.resolve();
        await release.promise;
        if (fail) throw new Error("commit acknowledgement lost");
      });
      let settled = false;
      const pending = writeBackCommittedRow(f.table, "row", () => decision, { label: "deadline", deadlineMs: 10 });
      const outcome = pending.then((value) => { settled = true; return value; }, (error) => { settled = true; return error; });
      await submitted.promise;
      await sleep(30);
      expect(settled).toBe(false);
      release.resolve();
      const result = await outcome;
      if (fail) {
        expect(result).toBeInstanceOf(WriteBackIndeterminateError);
        expect(result).not.toBeInstanceOf(WriteBackDeadlineError);
      } else {
        expect(result).toEqual(decision);
        expect(f.stored()).toEqual(decision.write);
      }
      expect(f.submissions()).toBe(1);
    });
  }
});
