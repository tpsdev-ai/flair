/**
 * `flair federation token`'s PairingToken rollback, against a REAL Harper
 * (flair#1895).
 *
 * The unit tests prove the requests we SEND and the line we print. They cannot
 * prove Harper ACCEPTS the delete: the rollback used to send the singular
 * `hash_value`, which Harper's delete schema refuses with a 400, so the
 * PairingToken outlived the bootstrap user it was minted for. Only a Harper can
 * answer that, so this file forces the add_user failure and then reads the
 * PairingToken table directly.
 *
 * FORCING THE FAILURE. `federation token` persists the token, then creates a
 * `pair-bootstrap-<prefix>` user with role `flair_pair_initiator`. A fresh
 * Harper has no such role, and `add_user` with an unknown role is a 400 — the
 * exact add_user failure the rollback exists for. The premise is asserted
 * (list_roles) so a Harper that ever ships the role fails this test LOUDLY
 * instead of leaving nothing to test.
 *
 * The CLI is built through the same helper as the #1894 harness
 * (test/helpers/build-cli-once.ts) — one bounded build per process, no second
 * build path. The harness HOME-isolates and sweeps its Harper.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { ensureCliBuild } from "../helpers/build-cli-once.js";

let harper: HarperInstance;
const CLI = join(process.cwd(), "dist", "cli.js");
const CHILD_DEADLINE_MS = 20_000;

/** One ops call against the live Harper. */
async function ops(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${harper.opsURL.replace(/\/$/, "")}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops ${String(body.operation)} failed (${res.status}): ${await res.text()}`);
  return await res.json().catch(() => null);
}

/** Every id a table holds, from the one ops read that can say "all". */
async function tokenIds(): Promise<string[]> {
  const parsed = await ops({ operation: "sql", sql: "SELECT id FROM flair.PairingToken" });
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : null;
  if (rows === null) throw new Error(`sql read returned no row array: ${JSON.stringify(parsed)}`);
  return rows.map((r: any) => String(r.id));
}

/** Run the shipped CLI with an isolated HOME; returns stdout+stderr+code. */
async function runCli(args: string[], home: string): Promise<{ code: number | null; out: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        HOME: home,
        FLAIR_URL: harper.httpURL,
        FLAIR_TOKEN: "",
        FLAIR_ADMIN_PASS: "",
      },
      timeout: CHILD_DEADLINE_MS,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(
          new Error(
            `cli ${args.join(" ")} was killed by ${signal} at the ${CHILD_DEADLINE_MS}ms deadline. Output so far:\n${out}`,
          ),
        );
        return;
      }
      resolve({ code, out });
    });
  });
}

describe("federation token rollback (live Harper)", () => {
  beforeAll(async () => {
    ensureCliBuild();
    harper = await startHarper();
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("a forced add_user failure actually deletes the PairingToken it persisted", async () => {
    // The premise of the forced failure: the role `federation token` needs is
    // absent on a fresh Harper. If this ever holds the role, the failure this
    // test relies on cannot be forced, and the test must fail here rather than
    // exercise a path that never ran.
    const roles = await ops({ operation: "list_roles" });
    expect(Array.isArray(roles)).toBe(true);
    expect(roles.map((r: any) => r.role ?? r.name)).not.toContain("flair_pair_initiator");

    // Start from an empty PairingToken table.
    for (const id of await tokenIds()) {
      await ops({ operation: "delete", database: "flair", table: "PairingToken", hash_values: [id] });
    }
    expect(await tokenIds()).toEqual([]);

    const home = await mkdtemp(join(tmpdir(), "flair-1895-"));
    let res: { code: number | null; out: string };
    try {
      res = await runCli(
        [
          "federation", "token",
          "--target", harper.httpURL,
          "--ops-target", harper.opsURL,
          "--admin-user", harper.admin.username,
          "--admin-pass", harper.admin.password,
        ],
        home,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }

    // The ORIGINAL failure is what the exit code reflects...
    expect(res.code).not.toBe(0);
    expect(res.out).toContain("Failed to create bootstrap user");
    // ...and the rollback is an ADDITIONAL line reporting what it did.
    expect(res.out).toContain("Rolled back pairing token");
    expect(res.out).toContain("Harper confirmed it was deleted");
    expect(res.out).not.toContain("rollback FAILED");

    // The row is GONE: Harper really removed it (the old `hash_value` delete was
    // refused with a 400 and left it here).
    expect(await tokenIds()).toEqual([]);
  }, 90_000);
});