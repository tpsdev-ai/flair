/**
 * federation-retry-probe-component.ts — flair#2455 slice 1 test seam.
 *
 * Composes a PRIVATE copy of the built component that adds three test-only
 * modules beside dist/resources/*.js (the component's own `jsResource` glob
 * loads them):
 *
 * - `zz-test-federation-retry-probe.js` — an admin-only resource whose POST
 *   calls the REAL retry transition (resources/FederationRetry.ts
 *   terminalizeRetryEntry) against the real FederationRetry table, and answers
 *   with its outcome. allowCreate()=allowAdmin, so only the test's admin Basic
 *   credential reaches it. A `pauseTag` in the body pauses that transition
 *   after its in-transaction read: the probe writes `reached.<tag>` under
 *   FLAIR_TEST_PAUSE_DIR, then waits (at most 15 s) for `release.<tag>`.
 * - `zz-test-failing-retry-write.js` — makes ONE FederationRetry.put throw on
 *   demand, when the test arms a marker file `arm.retry-write-fail` under
 *   FLAIR_TEST_PAUSE_DIR. The arm file is CONSUMED (one-shot).
 * - `zz-test-failing-peers-read.js` — makes GET /FederationPeers fail (500)
 *   while a marker file `arm.peers-read-fail` exists under FLAIR_TEST_PAUSE_DIR.
 *   The test removes the file to disarm it.
 *
 * Nothing under resources/ ships a pause or a failure switch.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_MODULE_REL = join("dist", "resources", "zz-test-federation-retry-probe.js");
export const FAILING_RETRY_WRITE_MODULE_REL = join("dist", "resources", "zz-test-failing-retry-write.js");
export const FAILING_PEERS_READ_MODULE_REL = join("dist", "resources", "zz-test-failing-peers-read.js");

export const PROBE_MODULE_SRC = `import { Resource } from "harper";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowAdmin } from "./agent-auth.js";
import { terminalizeRetryEntry } from "./FederationRetry.js";
function pauseFor(tag) {
  const dir = process.env.FLAIR_TEST_PAUSE_DIR;
  if (!dir || typeof tag !== "string" || !/^[a-z0-9-]{1,64}$/.test(tag)) return undefined;
  return async () => {
    writeFileSync(join(dir, "reached." + tag), "");
    const release = join(dir, "release." + tag);
    const deadline = Date.now() + 15000;
    while (!existsSync(release) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  };
}
export class ZzFederationRetryProbe extends Resource {
  async allowCreate() { return allowAdmin(this.getContext?.()); }
  async post({ peerId, table, recordId, resolution, bound, pauseTag }) {
    return await terminalizeRetryEntry({ peerId, table, recordId, resolution, bound, pausePoint: pauseFor(pauseTag) });
  }
}
`;

export const FAILING_RETRY_WRITE_MODULE_SRC = `import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { databases } from "harper";
const { FederationRetry } = databases.flair;
const put = FederationRetry.put;
FederationRetry.put = function (record, ...rest) {
  const dir = process.env.FLAIR_TEST_PAUSE_DIR;
  if (dir) {
    const arm = join(dir, "arm.retry-write-fail");
    if (existsSync(arm)) {
      unlinkSync(arm);
      throw new Error("test component: forced retry write failure");
    }
  }
  return put.call(this, record, ...rest);
};
`;

export const FAILING_PEERS_READ_MODULE_SRC = `import { existsSync } from "node:fs";
import { join } from "node:path";
import { FederationPeers } from "./Federation.js";
const get = FederationPeers.prototype.get;
FederationPeers.prototype.get = async function (...args) {
  const dir = process.env.FLAIR_TEST_PAUSE_DIR;
  if (dir && existsSync(join(dir, "arm.peers-read-fail"))) {
    throw new Error("test component: forced peer read failure");
  }
  return get.apply(this, args);
};
`;

export interface RetryProbeComponent {
  dir: string;
  cleanup: () => void;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Compose a private copy of the built component with the probe and the two failure modules. */
export function componentWithRetryProbe(opts: { sourceRoot?: string } = {}): RetryProbeComponent {
  const sourceRoot = opts.sourceRoot ?? repoRoot();
  const sourceResource = join(sourceRoot, "dist", "resources", "FederationRetry.js");
  if (!existsSync(sourceResource)) {
    throw new Error(`componentWithRetryProbe: built resource not found at ${sourceResource} — run \`bun run build\`.`);
  }
  const dir = mkdtempSync(join(tmpdir(), "flair-retry-probe-"));
  for (const entry of ["config.yaml", "package.json", "dist", "schemas"]) {
    const src = join(sourceRoot, entry);
    if (!existsSync(src)) continue;
    cpSync(src, join(dir, entry), { recursive: true });
  }
  const nmSrc = join(sourceRoot, "node_modules");
  if (existsSync(nmSrc)) symlinkSync(nmSrc, join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, PROBE_MODULE_REL), PROBE_MODULE_SRC);
  writeFileSync(join(dir, FAILING_RETRY_WRITE_MODULE_REL), FAILING_RETRY_WRITE_MODULE_SRC);
  writeFileSync(join(dir, FAILING_PEERS_READ_MODULE_REL), FAILING_PEERS_READ_MODULE_SRC);
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 4 }); } catch { /* best effort */ }
    },
  };
}
