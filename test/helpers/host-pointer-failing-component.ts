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
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
export { PointerAlreadyStoredError } from "./host-pointer/registry.js";
export { putPointerRow as restorePointerRowIfAbsent };
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

/** Where a composed copy writes the failing promotion-stamp module: a
 *  top-level built resource file, loaded with the rest of `dist/resources`. */
export const FAILING_STAMP_MODULE_REL = join("dist", "resources", "zz-test-failing-promotion-stamp.js");

/** A test-only module for a composed copy (see
 *  `componentWithFailingPromotionStamp`): a Memory table write that carries an
 *  approved promotion verdict for an agent whose id contains
 *  `stamp-failure` throws. The message says whether the write's context
 *  carried an open, joinable transaction (the shape `isJoinableTransaction`
 *  accepts), so a test can assert which stamp branch it reached. */
export const FAILING_STAMP_MODULE_SRC = `import { databases } from "harper";
const { Memory } = databases.flair;
const memoryPut = Memory.put;
Memory.put = function (record, ...rest) {
  if (record?.promotionStatus === "approved" && typeof record?.agentId === "string" && record.agentId.includes("stamp-failure")) {
    const t = rest[0]?.transaction;
    const open = !!t && t.open === 1 && !t.saveCommits;
    throw new Error("test component: forced promotion stamp failure (" + (open ? "transaction open" : "no open transaction") + ")");
  }
  return memoryPut.call(this, record, ...rest);
};
const memoryUpdate = Memory.update;
Memory.update = async function (id, patch, ...rest) {
  if (patch?.promotionStatus === "approved") {
    const row = await Memory.get(id, rest[0]);
    if (typeof row?.agentId === "string" && row.agentId.includes("stamp-failure")) {
      const t = rest[0]?.transaction;
      const open = !!t && t.open === 1 && !t.saveCommits;
      throw new Error("test component: forced promotion stamp failure (" + (open ? "transaction open" : "no open transaction") + ")");
    }
  }
  return memoryUpdate.call(this, id, patch, ...rest);
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

/** A composed copy that keeps every built resource and adds the failing
 *  promotion-stamp module (FAILING_STAMP_MODULE_SRC). */
export function componentWithFailingPromotionStamp(opts: { sourceRoot?: string } = {}): FailingComponent {
  return composeComponent({ [FAILING_STAMP_MODULE_REL]: FAILING_STAMP_MODULE_SRC }, opts.sourceRoot ?? repoRoot());
}

/** Where a composed copy writes the failing re-pair Peer-write module: a
 *  top-level built resource file, loaded with the rest of `dist/resources`. */
export const FAILING_REPAIR_PEER_WRITE_MODULE_REL = join("dist", "resources", "zz-test-failing-repair-peer-write.js");

/** A test-only module for a composed copy (see
 *  `componentWithFailingRepairPeerWrite`): one `Peer.put` is failed ON DEMAND,
 *  when the test arms a marker file named `arm.repair-peer-write-fail.<peerId>`
 *  under FLAIR_TEST_PAUSE_DIR. The arm file is CONSUMED (one-shot).
 *  On Federation.ts's token re-pair path the write
 *  lands INSIDE the owned transaction, after the token consume has been staged. */
export const FAILING_REPAIR_PEER_WRITE_MODULE_SRC = `import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { databases } from "harper";
const { Peer } = databases.flair;
const peerPut = Peer.put;
Peer.put = function (record, ...rest) {
  const dir = process.env.FLAIR_TEST_PAUSE_DIR;
  const id = record?.id;
  if (dir && typeof id === "string") {
    const arm = join(dir, "arm.repair-peer-write-fail." + id);
    if (existsSync(arm)) {
      unlinkSync(arm);
      throw new Error("test component: forced re-pair Peer write failure");
    }
  }
  return peerPut.call(this, record, ...rest);
};
`;

/** A composed copy that keeps every built resource and adds the failing
 *  re-pair Peer-write module (FAILING_REPAIR_PEER_WRITE_MODULE_SRC). */
export function componentWithFailingRepairPeerWrite(opts: { sourceRoot?: string } = {}): FailingComponent {
  return composeComponent({ [FAILING_REPAIR_PEER_WRITE_MODULE_REL]: FAILING_REPAIR_PEER_WRITE_MODULE_SRC }, opts.sourceRoot ?? repoRoot());
}

/** The armable Memory read failure, bound to a calling phase (flair#3053).
 *
 * The composed copy replaces `Memory.get` with one that fails the read when
 * `arm.memory-get-fail.<id>` exists AND the caller's stack carries the frame of
 * the phase the arm names. A read of the same id by any other caller leaves the
 * arm in place, so a background writer (the embedding backfill, a scan) cannot
 * consume the failure the test armed for its own read-back. The arm is
 * one-shot: the matching read removes it, records its stack in
 * `consumed.memory-get-fail.<id>`, and throws.
 */
export const MEMORY_READ_PHASES = {
  /** The ordinary PUT/PATCH/Skill post-commit verification read. */
  "memory-patch-verify": ["verifyWrittenRow ("],
  "memory-put-verify": ["verifyWrittenRow ("],
  /** The feed write-back's post-commit read (resources/write-back.ts). */
  "feed-write-back": ["writeBackCommittedRow ("],
  /** The embedding backfill's post-commit read, same site as the feed's. */
  "backfill-read-back": ["writeBackCommittedRow ("],
  /** The feed dedup repair's confirmation read (resources/MemoryFeed.ts). */
  "feed-dedup-repair": ["repairDeduplicatedExpiryLocked ("],
  /** The re-embed PATCH's post-commit verification read. */
  "reembed-verify": ["reembedStoredRow ("],
  /** The embedding-stamp migration's `.content`-suffix fallback read. */
  "content-suffix-verify": ["regenContentSuffixRow ("],
  /** The migration's fresh read on the retry after an unconfirmed attempt. */
  "content-suffix-retry": ["embedding-stamp.js", "Object.run ("],
} as const;

export type MemoryReadPhase = keyof typeof MEMORY_READ_PHASES;

/** The one built resource the composed copy installs the armable read failure as. */
export const FAILING_MEMORY_READ_MODULE_REL = join("dist", "resources", "zz-test-failing-memory-read.js");

export const FAILING_MEMORY_READ_MODULE_SRC = `import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { databases } from "harper";
const { Memory } = databases.flair;
// Each phase names the frames of the read the test means; the arm is consumed
// only from a stack that carries one of them (flair#3053).
const PHASES = ${JSON.stringify(MEMORY_READ_PHASES)};
const memoryGet = Memory.get;
Memory.get = function (id, ...rest) {
  const dir = process.env.FLAIR_TEST_PAUSE_DIR;
  if (dir && (typeof id === "string" || typeof id === "number")) {
    const arm = join(dir, "arm.memory-get-fail." + id);
    if (existsSync(arm)) {
      const phase = readFileSync(arm, "utf8").trim();
      const frames = PHASES[phase];
      const stack = new Error("armed Memory read").stack ?? "";
      const matches = Array.isArray(frames) &&
        stack.split(String.fromCharCode(10)).some((line) => frames.every((part) => line.includes(part)));
      if (matches) {
        unlinkSync(arm);
        writeFileSync(join(dir, "consumed.memory-get-fail." + id), stack);
        throw new Error("test component: forced Memory read failure (" + phase + ")");
      }
    }
  }
  return memoryGet.call(this, id, ...rest);
};
`;

/** Arm the read failure for `id`, bound to `phase` (one of {@link MEMORY_READ_PHASES}). */
export function armMemoryReadFailure(pauseDir: string, id: string, phase: MemoryReadPhase): void {
  writeFileSync(join(pauseDir, `arm.memory-get-fail.${id}`), phase);
}

/** The stack of the read that consumed the arm for `id`, or null if none did. */
export function memoryReadConsumerStack(pauseDir: string, id: string): string | null {
  const path = join(pauseDir, `consumed.memory-get-fail.${id}`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** A composed copy that keeps every built resource and adds the armable Memory
 *  read failure (FAILING_MEMORY_READ_MODULE_SRC). */
export function componentWithFailingMemoryRead(opts: { sourceRoot?: string } = {}): FailingComponent {
  return composeComponent({ [FAILING_MEMORY_READ_MODULE_REL]: FAILING_MEMORY_READ_MODULE_SRC }, opts.sourceRoot ?? repoRoot());
}

/** Where a composed copy writes the second-caller read probe. */
export const SECOND_READ_MODULE_REL = join("dist", "resources", "zz-test-second-reader.js");

/** A test-only resource that reads one id through `Memory.get` on request, so a
 *  test can prove an armed failure is not consumed by another caller's read
 *  (flair#3053). POST /MemoryReadProbe/ {"op":"read","id":<id>}. */
export const SECOND_READ_MODULE_SRC = `import { Resource, databases } from "harper";
export class MemoryReadProbe extends Resource {
  allowCreate() {
    return true;
  }

  async post(body) {
    if (body?.op !== "read") return { error: "unknown op" };
    // A background reader swallows its own read error; report it instead.
    try {
      const row = await databases.flair.Memory.get(String(body.id), {});
      return { found: row != null };
    } catch (err) {
      return { found: false, failed: String(err?.message ?? err) };
    }
  }
}
`;

/** A composed copy that keeps every built resource and adds the second-caller
 *  read probe (SECOND_READ_MODULE_SRC). */
export function componentWithSecondReader(opts: { sourceRoot?: string } = {}): FailingComponent {
  return composeComponent({ [SECOND_READ_MODULE_REL]: SECOND_READ_MODULE_SRC }, opts.sourceRoot ?? repoRoot());
}
