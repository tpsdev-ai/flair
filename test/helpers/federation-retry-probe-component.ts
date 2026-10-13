/**
 * federation-retry-probe-component.ts — flair#2455 slice 1 test seam.
 *
 * Composes a PRIVATE copy of the built component that adds two test-only
 * modules beside dist/resources/*.js (the component's own `jsResource` glob
 * loads them):
 *
 * - `zz-test-federation-retry-probe.js` — an admin-only resource whose POST
 *   calls the REAL retry transition (resources/FederationRetry.ts
 *   terminalizeRetryEntry) against the real FederationRetry table, and answers
 *   with its outcome. allowCreate()=allowAdmin, so only the test's admin Basic
 *   credential reaches it.
 * - `zz-test-failing-retry-write.js` — makes ONE FederationRetry.put throw on
 *   demand, when the test arms a marker file `arm.retry-write-fail` under
 *   FLAIR_TEST_PAUSE_DIR. The arm file is CONSUMED (one-shot). Nothing under
 *   resources/ ships a failure switch.
 */
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_MODULE_REL = join("dist", "resources", "zz-test-federation-retry-probe.js");
export const FAILING_RETRY_WRITE_MODULE_REL = join("dist", "resources", "zz-test-failing-retry-write.js");

export const PROBE_MODULE_SRC = `import { Resource } from "harper";
import { allowAdmin } from "./agent-auth.js";
import { terminalizeRetryEntry } from "./FederationRetry.js";
export class ZzFederationRetryProbe extends Resource {
  async allowCreate() { return allowAdmin(this.getContext?.()); }
  async post({ peerId, table, recordId, resolution, bound }) {
    return await terminalizeRetryEntry({ peerId, table, recordId, resolution, bound });
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

export interface RetryProbeComponent {
  dir: string;
  cleanup: () => void;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Compose a private copy of the built component with the probe + failing-write modules. */
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
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 4 }); } catch { /* best effort */ }
    },
  };
}
