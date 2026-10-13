/**
 * own-harper-instance.ts — the own-instance check for a test that inserts
 * Memory rows into a Harper it spawned (flair#2508).
 *
 * Used by test/integration/embedding-space-scan-order-2508.test.ts and by its
 * subprocess fixture test/fixtures/external-harper-insert-2508.ts, which runs
 * the check against the instance the REAL `startHarper` external branch
 * returns. No bun:test import, so a plain `bun` subprocess can load it.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative } from "node:path";
import type { HarperInstance } from "./harper-lifecycle";

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Refuse any Harper the caller did not spawn itself. Runs before the first
 *  Memory row insert: an external instance (HARPER_HTTP_URL), one without a
 *  live spawned process, and one whose install dir is not a temporary dir the
 *  caller owns are refused, as are a non-loopback or production port and HTTP
 *  and operations sharing a port. */
export function assertOwnInstance(h: HarperInstance): void {
  if (h.external) {
    throw new Error(`refusing an external Harper (${h.httpURL}): this test inserts Memory rows and runs only against an instance it spawned`);
  }
  const proc = h.process;
  if (!proc || !(Number(proc.pid) > 0) || proc.exitCode !== null || proc.signalCode !== null) {
    throw new Error(`refusing ${h.httpURL}: no live process spawned by this test`);
  }
  let ownedTemp = false;
  try {
    ownedTemp = h.ownsInstallDir && h.installDir !== "" && isInside(realpathSync(tmpdir()), realpathSync(h.installDir));
  } catch { /* an unresolvable dir is not owned */ }
  if (!ownedTemp) {
    throw new Error(`refusing ${h.httpURL}: install dir ${JSON.stringify(h.installDir)} is not a temporary dir this test owns`);
  }
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing ${u.href}: not a loopback, non-production port`);
    }
  }
  if (http.port === ops.port) throw new Error(`refusing ${h.httpURL}: HTTP and operations share a port`);
}

export const basicAuthOf = (h: HarperInstance) => "Basic " + btoa(`${h.admin.username}:${h.admin.password}`);

/** Insert Memory rows through the operations API. The own-instance check runs
 *  before the request is built; a non-200 answer throws with its status. */
export async function insertMemoryRows(h: HarperInstance, records: Record<string, unknown>[]): Promise<void> {
  assertOwnInstance(h);
  const res = await fetch(h.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuthOf(h) },
    body: JSON.stringify({ operation: "insert", database: "flair", table: "Memory", records }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`insert returned ${res.status}: ${text.slice(0, 200)}`);
}
