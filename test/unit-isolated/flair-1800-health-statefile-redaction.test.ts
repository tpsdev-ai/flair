/**
 * flair#1800 review C2 — /HealthDetail must not leak the migration state-file's
 * absolute path (nor the raw filesystem error that embeds it) to a verified
 * NON-admin caller.
 *
 * `HealthDetail.allowRead` is `allowVerified`, so any verified agent reaches
 * this resource, while it keeps absolute paths admin-only elsewhere (the disk
 * block below does `isAdmin ? dataDir : redactHome(dataDir)`). The migrations
 * detail's new `stateFile` field must follow the same idiom.
 *
 * These cases drive the REAL resource with a mocked context: a verified
 * non-admin agent (`request.tpsAgent` set, `tpsAgentIsAdmin` false) and an admin,
 * and assert the `stats.migrations.stateFile` shape each one sees.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

// Mock `harper` so importing the resource never touches a real (production)
// data dir. A permissive proxy supplies a no-op for any other named export the
// transitive import graph asks for.
mock.module("harper", () => {
  const noop = () => {};
  const base: any = {
    server: { http: noop, getUser: async () => null },
    databases: { flair: {} },
    Resource: class {},
    logger: { info: noop, warn: noop, error: noop, debug: noop, trace: noop },
  };
  return new Proxy(base, {
    get: (t, p: string) => (p in t ? t[p] : noop),
  }) as any;
});

const { HealthDetail } = await import("../../resources/health.ts");
const { noteStateWriteAttempt, noteStateWriteFailure, _resetProgressForTests } = await import(
  "../../resources/migrations/progress.ts"
);

const STATE_PATH = join(homedir(), ".flair", "data", ".migrations", "state.json");
const WRITE_ERROR = {
  migrationId: "visibility-backfill",
  at: "2026-01-01T00:00:00.000Z",
  message: `ENOTDIR: not a directory, open '${STATE_PATH}'`,
};

function makeDetail(opts: { agent?: string; isAdmin?: boolean }): any {
  const d: any = new HealthDetail();
  d.getContext =
    opts.agent === undefined
      ? () => ({})
      : () => ({ request: { tpsAgent: opts.agent, tpsAgentIsAdmin: opts.isAdmin === true } });
  return d;
}

beforeEach(() => {
  _resetProgressForTests();
  noteStateWriteAttempt(STATE_PATH);
  noteStateWriteFailure(WRITE_ERROR);
});

afterEach(() => {
  _resetProgressForTests();
});

describe("flair#1800 C2 — /HealthDetail stateFile is redacted for non-admin callers", () => {
  test("a verified NON-admin caller: path is home-redacted and the raw error message is ABSENT", async () => {
    const stats: any = await makeDetail({ agent: "agent-x", isAdmin: false }).get();
    const sf = stats.migrations.stateFile;
    expect(sf.path).toContain("~"); // redacted
    expect(sf.path).not.toContain(homedir()); // no absolute home path
    expect(sf.lastWriteError.migrationId).toBe("visibility-backfill");
    expect(sf.lastWriteError.at).toBe("2026-01-01T00:00:00.000Z");
    // The positive claim: the message (which embeds the path) is GONE, not merely
    // truncated.
    expect("message" in sf.lastWriteError).toBe(false);
    expect(JSON.stringify(sf)).not.toContain("ENOTDIR");
  });

  test("an admin caller: the full record (absolute path + message) is unchanged", async () => {
    const stats: any = await makeDetail({ agent: "admin-agent", isAdmin: true }).get();
    const sf = stats.migrations.stateFile;
    expect(sf.path).toBe(STATE_PATH);
    expect(sf.lastWriteError.migrationId).toBe("visibility-backfill");
    expect(sf.lastWriteError.message).toContain("ENOTDIR");
  });

  test("no write attempt yet: stateFile.path is null for both callers", async () => {
    _resetProgressForTests();
    const nonAdmin: any = await makeDetail({ agent: "agent-x", isAdmin: false }).get();
    expect(nonAdmin.migrations.stateFile.path).toBeNull();
    const admin: any = await makeDetail({ agent: "admin-agent", isAdmin: true }).get();
    expect(admin.migrations.stateFile.path).toBeNull();
  });
});
