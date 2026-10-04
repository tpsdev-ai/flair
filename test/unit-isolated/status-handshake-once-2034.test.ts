/**
 * status-handshake-once-2034.test.ts — flair#2034 §2.
 *
 * `flair status` reports the server's version itself and decides its advice
 * from the install-tree comparison. The per-command CLI↔server handshake
 * (a tree-blind "installed but server is running X — run: flair restart" on
 * stderr) must therefore not ALSO fire for top-level `status` — that second
 * line is one of the two hints that used to contradict each other.
 *
 * Runs the real program in-process with a TTY stdout (the hook only fires for
 * a TTY), a scratch HOME set before src/cli.ts is imported, and every network
 * request answered by a stub reporting an older server. mock.module is
 * process-global, hence unit-isolated.
 */
import { describe, test, expect, mock, spyOn, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "flair-2034-handshake-home-"));
const ISOLATED_ENV_KEYS = ["HOME", "FLAIR_URL", "FLAIR_TARGET", "ROOTPATH", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD", "FLAIR_AGENT_ID"] as const;
const SAVED_ENV: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) SAVED_ENV[key] = process.env[key];
process.env.HOME = TEST_HOME;
for (const key of ISOLATED_ENV_KEYS) if (key !== "HOME") delete process.env[key];

mock.module("node:os", () => {
  const actual = { ...require("node:os") };
  return { ...actual, homedir: () => process.env.HOME || actual.homedir() };
});

afterAll(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const { program } = await import("../../src/cli.ts");

describe("flair status and the version handshake (#2034)", () => {
  test("top-level status does not also print the handshake's 'run: flair restart' nudge", async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(" ")); });
    const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    const exitSpy = spyOn(process, "exit").mockImplementation((() => { throw new Error("__exit__"); }) as any);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: "0.0.1", pid: 1 }), { status: 200 })
    ) as unknown as typeof fetch;
    const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      await program.parseAsync(["node", "flair", "status"]);
    } catch (err) {
      if ((err as Error).message !== "__exit__") throw err;
    } finally {
      if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
      else delete (process.stdout as any).isTTY;
      globalThis.fetch = origFetch;
      errSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
    // status itself states the server's version once…
    expect(logs.join("\n")).toContain("the server is running flair 0.0.1");
    // …and the tree-blind handshake nudge is not printed on top of it.
    expect(errors.join("\n")).not.toContain("installed but server is running");
  }, 60_000);
});
