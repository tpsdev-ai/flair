/**
 * host-pointer-failing-component.ts — flair#1940 slice 1 (A1-iv item 6/7).
 *
 * Composes a PRIVATE copy of the built component whose pointer-table ADAPTER
 * (`dist/resources/host-pointer-adapter.js`) is REPLACED with one that throws
 * on every put/delete. This is the test-only build replacement the design
 * calls for: the production tree ships NO failure switch; only this composed
 * copy forces a pointer-write/delete failure, so a real-Harper integration test
 * can assert the rollback. Nothing under resources/ is changed.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The one built resource the composed copy replaces (the pointer adapter). */
export const ADAPTER_REL = join("dist", "resources", "host-pointer-adapter.js");

export interface FailingComponent {
  dir: string;
  cleanup: () => void;
}

const FAILING_ADAPTER_JS = `// Test-only build replacement: every pointer-table write/delete throws.
// ESM, matching the package's "type": "module" - a CJS exports.* file would
// not be the module the loader imports, so the failure would never be injected.
export async function putPointerRow() { throw new Error("test adapter: forced host-pointer write failure"); }
export async function deletePointerRowViaTable() { throw new Error("test adapter: forced host-pointer delete failure"); }
`;

/** The exact ESM source the composed copy writes over the adapter, so a test
 *  can assert the composed file IS the failing adapter (a positive control). */
export const FAILING_ADAPTER_SRC = FAILING_ADAPTER_JS;

/** Where a composed copy writes the concurrent-write module: a top-level built
 *  resource file, so the component loads it with the rest of `dist/resources`. */
export const CONCURRENT_WRITE_MODULE_REL = join("dist", "resources", "zz-test-concurrent-write.js");

/** A test-only module for a composed copy (see `componentWithConcurrentWrites`).
 *  Right after the caller stages its own write,
 *  the wrapper commits a newer write of the same row in a separate transaction,
 *  so the caller's staged delete loses to that write at commit. A row opts in
 *  by a marker in its Memory id:
 *    skip-memory-delete   a deletion-history put for the row → a newer write of
 *                         the Memory row (its delete is staged before the put);
 *    skip-history-delete  a deletion-history delete for the row → a newer write
 *                         of that history record;
 *    skip-pointer-delete  a pointer-row delete for the row → a newer write of
 *                         that pointer row.
 */
export const CONCURRENT_WRITE_MODULE_SRC = `import { databases } from "harper";
import { MemoryPurge } from "./MemoryPurge.js";
const { Memory, MemoryDeletionHistory, MemoryHostSource } = databases.flair;
const purgePost = MemoryPurge.prototype.post;
MemoryPurge.prototype.post = async function (data) {
  const id = data?.ids?.find((id) => typeof id === "string" && id.includes("pinned-pointer-snapshot"));
  if (!id) return purgePost.call(this, data);
  return globalThis.transaction(this.getContext(), async () => {
    const pointers = MemoryHostSource.search({ conditions: [{ attribute: "memoryId", comparator: "equals", value: id }] });
    let found = false;
    for await (const row of pointers) if (row.memoryId === id) found = true;
    if (!found) throw new Error("test component: pointer row not found");
    return purgePost.call(this, data);
  });
};
const historyPut = MemoryDeletionHistory.put;
const historyDelete = MemoryDeletionHistory.delete;
const pointerPut = MemoryHostSource.put;
const pointerDelete = MemoryHostSource.delete;
const pointerSearch = MemoryHostSource.search;
const pointerConfirmationFailures = new Set();
async function separately(fn) {
  const separate = {};
  await globalThis.transaction(separate, () => fn(separate));
}
MemoryDeletionHistory.put = async function (record, ...rest) {
  const result = await historyPut.call(this, record, ...rest);
  const memoryId = record?.memoryId;
  if (typeof memoryId === "string" && memoryId.includes("skip-memory-delete")) {
    await separately(async (s) => {
      const row = await Memory.get(memoryId, s);
      if (row) await Memory.put({ ...row, content: "rewritten by a separate transaction" }, s);
    });
  }
  return result;
};
MemoryDeletionHistory.delete = async function (id, ...rest) {
  const result = await historyDelete.call(this, id, ...rest);
  await separately(async (s) => {
    const record = await MemoryDeletionHistory.get(id, s);
    if (record && typeof record.memoryId === "string" && record.memoryId.includes("skip-history-delete")) {
      await historyPut.call(MemoryDeletionHistory, { ...record }, s);
    }
  });
  return result;
};
MemoryHostSource.delete = async function (memoryId, ...rest) {
  const result = await pointerDelete.call(this, memoryId, ...rest);
  if (typeof memoryId === "string" && memoryId.includes("fail-pointer-confirmation")) pointerConfirmationFailures.add(memoryId);
  if (typeof memoryId === "string" && memoryId.includes("skip-pointer-delete")) {
    await separately(async (s) => {
      const row = await MemoryHostSource.get(memoryId, s);
      if (row) await pointerPut.call(MemoryHostSource, { ...row, receivedAt: new Date().toISOString() }, s);
    });
  }
  return result;
};
MemoryHostSource.search = function (query, ...rest) {
  const failed = query?.conditions?.find((c) => pointerConfirmationFailures.has(c.value));
  if (failed) {
    pointerConfirmationFailures.delete(failed.value);
    throw new Error("test component: forced pointer confirmation failure");
  }
  return pointerSearch.call(this, query, ...rest);
};
`;

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Compose a private copy of the built component with `files` (path relative
 *  to the copy → contents) written over or beside the built files. */
function composeComponent(files: Record<string, string>, sourceRoot: string): FailingComponent {
  const sourceAdapter = join(sourceRoot, ADAPTER_REL);
  if (!existsSync(sourceAdapter)) {
    throw new Error(`composeComponent: source adapter not found at ${sourceAdapter} — run \`bun run build\`.`);
  }
  const dir = mkdtempSync(join(tmpdir(), "flair-failing-pointer-"));
  for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
    const src = join(sourceRoot, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(dir, entry), { recursive: true });
  }
  const nmSrc = join(sourceRoot, "node_modules");
  if (existsSync(nmSrc)) symlinkSync(nmSrc, join(dir, "node_modules"), "dir");
  for (const [rel, contents] of Object.entries(files)) writeFileSync(join(dir, rel), contents);
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 4 }); } catch { /* best effort */ }
    },
  };
}

export function componentWithFailingHostPointer(opts: { sourceRoot?: string } = {}): FailingComponent {
  return composeComponent({ [ADAPTER_REL]: FAILING_ADAPTER_JS }, opts.sourceRoot ?? repoRoot());
}

/** A composed copy that keeps the built pointer adapter and adds the
 *  concurrent-write module (CONCURRENT_WRITE_MODULE_SRC). */
export function componentWithConcurrentWrites(opts: { sourceRoot?: string } = {}): FailingComponent {
  return composeComponent({ [CONCURRENT_WRITE_MODULE_REL]: CONCURRENT_WRITE_MODULE_SRC }, opts.sourceRoot ?? repoRoot());
}
