import { writeJournalScope as active } from "./write-journal-context.js";
export { currentWriteJournal } from "./write-journal-context.js";
import { isDeepStrictEqual } from "node:util";
import { databases } from "harper";
import { isMemoryHostSourceStore, loadStoredPointer, storedPointerIds } from "./memory-host-source.js";
import { txnPausePoint } from "./txn-pause-point.js";

type Entry = { operation: any; transaction: any; before?: any; after?: any; applied: boolean; version?: number };
function materialize(value: any, seen = new WeakMap<object, any>()): any {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date || value instanceof RegExp) {
    return structuredClone(value);
  }
  if (value instanceof Map) {
    const result = new Map();
    seen.set(value, result);
    for (const [key, item] of value) result.set(materialize(key, seen), materialize(item, seen));
    return result;
  }
  if (value instanceof Set) {
    const result = new Set();
    seen.set(value, result);
    for (const item of value) result.add(materialize(item, seen));
    return result;
  }
  const source = Object.keys(value).length === 0 && typeof value.toJSON === "function" ? value.toJSON() : value;
  const result: any = Array.isArray(source) ? [] : {};
  seen.set(value, result);
  if (source !== value) seen.set(source, result);
  if (Array.isArray(source)) result.length = source.length;
  for (const key of Object.keys(source)) {
    Object.defineProperty(result, key, { value: materialize(source[key], seen), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
const copy = (value: any) => value == null ? undefined : materialize(value);
const equal = (a: any, b: any) => isDeepStrictEqual(copy(a), copy(b));
function undoable(entry: Entry, current: any): boolean {
  if (!equal(current, entry.after)) return false;
  if (entry.before !== undefined || !entry.after?.tags?.includes("skill")) return true;
  return current && current.archived !== true && !current.validTo &&
    (current.expiresAt == null || (typeof current.expiresAt === "string" && Date.parse(current.expiresAt) > Date.now()));
}

/** Captures every addWrite in the owned transaction, including caller hooks. */
export class WriteJournal {
  readonly entries: Entry[] = [];
  pointerChanged = false;
  compensationAttempted = false;
  private readonly staged = new Set<any>();
  private readonly transactions = new Set<any>();
  private readonly owners = new WeakMap<object, any>();

  assertCoverage(): void {
    const recorded = new Set(this.entries.map((entry) => entry.operation));
    for (const txn of this.transactions) for (const operation of txn.writes ?? []) {
      if (operation && !recorded.has(operation)) throw new Error("write journal: staged write has no inverse");
    }
    for (const operation of this.staged) {
      if (!recorded.has(operation)) throw new Error("write journal: staged write has no inverse");
    }
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return active.run(this, fn);
  }

  async transaction<T>(ctx: any, fn: (capture: () => void, complete: () => void) => Promise<T>): Promise<T> {
    let callbackCompleted = false;
    const releases: (() => void)[] = [];
    const links = new Set<any>();
    const attach = (txn: any) => {
      if (!txn || links.has(txn)) return;
      if (typeof txn.addWrite !== "function") throw new Error("write journal: transaction staging unavailable");
      links.add(txn);
      this.transactions.add(txn);
      const addWrite = txn.addWrite;
      const ownAddWrite = Object.getOwnPropertyDescriptor(txn, "addWrite");
      txn.addWrite = (operation: any) => {
        const entry: Entry = { operation, transaction: txn, before: copy(operation.entry?.value), applied: false };
        this.entries.push(entry);
        this.staged.add(operation);
        this.owners.set(operation, txn);
        const commit = operation.commit;
        if (typeof commit !== "function" || !operation.store || operation.key == null) {
          throw new Error("write journal: unsupported staged write");
        }
        operation.commit = (...args: any[]) => {
          let prior = operation.priorWrite;
          while (prior && !prior.stagedEntry) prior = prior.priorWrite;
          entry.before = copy((prior?.stagedEntry ?? args[1])?.value);
          const result = commit.apply(operation, args);
          if (result?.then) throw new Error("write journal: asynchronous commit unsupported");
          entry.applied = operation.stagedEntry !== undefined;
          entry.after = copy(operation.stagedEntry?.value);
          entry.version = args[0];
          return result;
        };
        return addWrite.call(txn, operation);
      };
      const ownNext = Object.getOwnPropertyDescriptor(txn, "next");
      let next = txn.next;
      Object.defineProperty(txn, "next", {
        configurable: true,
        enumerable: ownNext?.enumerable ?? true,
        get: () => next,
        set: (value) => { attach(value); next = value; },
      });
      releases.push(() => {
        if (ownAddWrite) Object.defineProperty(txn, "addWrite", ownAddWrite);
        else delete txn.addWrite;
        Object.defineProperty(txn, "next", { configurable: true, enumerable: ownNext?.enumerable ?? true, writable: true, value: next });
      });
      attach(next);
    };
    const capture = () => attach(ctx?.transaction);
    try {
      const result = await fn(capture, () => { callbackCompleted = true; });
      this.assertCoverage();
      return result;
    } catch (err) {
      if (!callbackCompleted) {
        for (const txn of links) this.transactions.delete(txn);
        for (let index = this.entries.length - 1; index >= 0; index--) {
          if (links.has(this.entries[index].transaction)) this.entries.splice(index, 1);
        }
        for (const operation of this.staged) {
          if (links.has(this.owners.get(operation))) this.staged.delete(operation);
        }
      }
      throw err;
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  async undo(ctx: any, transact: <T>(ctx: any, fn: (shared: any) => Promise<T>) => Promise<T>): Promise<boolean> {
    return active.run(null, async () => {
      this.assertCoverage();
      let confirmed = true;
      const undone = new Map<any, Map<any, { read: (ctx: any) => Promise<any>; entry: Entry }>>();
      const versions = new Map<any, Map<any, number | undefined>>();
      for (const entry of [...this.entries].reverse()) {
        if (!entry.applied) continue;
        const { operation } = entry;
        const table: any = Object.values(databases as any).flatMap((db: any) => Object.values(db))
          .find((t: any) => t?.primaryStore === operation.store);
        const raw = Object.getPrototypeOf(table ?? {});
        if (!table || !raw?.get || !raw?.put || !raw?.delete) { confirmed = false; continue; }
        const pointer = isMemoryHostSourceStore(operation.store);
        const read = async (shared: any) => {
          if (!pointer) return raw.get.call(table, operation.key, shared);
          await storedPointerIds([String(operation.key)], shared);
          return loadStoredPointer(String(operation.key), shared);
        };
        const version = table === (databases as any).flair.InstructionVersion;
        const successor = table === (databases as any).flair.Memory && entry.before === undefined && entry.after?.tags?.includes("skill");
        const restore = pointer && entry.before !== undefined && entry.after === undefined;
        const pause = async (pending: Promise<void> | undefined) => { if (pending) await pending; };
        if (successor) await pause(txnPausePoint("skill-update-successor-rollback-start"));
        if (restore) await pause(txnPausePoint("skill-update-pointer-restore-start"));
        try {
          const current = await read({});
          if (!undoable(entry, current)) {
            if (pointer && current?.hostSource != null) this.pointerChanged = true;
            confirmed = false; continue;
          }
          const journal = this;
          let undoVersion: number | undefined;
          const expectedVersion = versions.get(operation.store)?.get(operation.key) ?? entry.version;
          await transact(ctx, async (shared) => {
            const stored = await read(shared);
            if (!undoable(entry, stored)) throw new Error("write journal: undo target changed");
            const guard = {
              store: operation.store, key: operation.key, reloadCommitBase: true, entry: undefined as any,
              commit(time: number, value: any) {
                undoVersion = time;
                if (!undoable(entry, value?.value) || (value && value.version !== expectedVersion)) {
                  if (pointer && value?.value?.hostSource != null) journal.pointerChanged = true;
                  throw new Error("write journal: undo target changed");
                }
              },
            };
            shared.transaction.addWrite(guard);
            if (guard.entry === undefined) guard.entry = null;
            if (entry.before === undefined) await raw.delete.call(table, operation.key, shared);
            else await raw.put.call(table, copy(entry.before), shared);
            if (version) await pause(txnPausePoint("skill-journal-version-rollback-staged"));
            if (restore) await pause(txnPausePoint("skill-update-pointer-restore-staged"));
          });
          if (version) await pause(txnPausePoint("skill-journal-version-rollback-committed"));
          if (successor) await pause(txnPausePoint("skill-update-successor-rollback-committed"));
          if (!equal(await read({}), entry.before)) confirmed = false;
          const committedEntry = operation.store.getEntry(operation.key, { uncachedRead: true });
          if (committedEntry && committedEntry.version !== undoVersion) confirmed = false;
          let byKey = undone.get(operation.store);
          if (!byKey) undone.set(operation.store, byKey = new Map());
          byKey.set(operation.key, { read, entry });
          let byVersion = versions.get(operation.store);
          if (!byVersion) versions.set(operation.store, byVersion = new Map());
          byVersion.set(operation.key, undoVersion);
        } catch {
          confirmed = false;
          try {
            const current = await read({});
            if (pointer && current?.hostSource != null && !equal(current, entry.before)) this.pointerChanged = true;
          } catch {}
        }
      }
      for (const byKey of undone.values()) for (const { read, entry } of byKey.values()) {
        try {
          const current = await read({});
          const stored = entry.operation.store.getEntry(entry.operation.key, { uncachedRead: true });
          const version = versions.get(entry.operation.store)?.get(entry.operation.key);
          if (!equal(current, entry.before) || (stored && stored.version !== version)) {
            if (isMemoryHostSourceStore(entry.operation.store) && current?.hostSource != null) this.pointerChanged = true;
            confirmed = false;
          }
        } catch { confirmed = false; }
      }
      return confirmed;
    });
  }
}
