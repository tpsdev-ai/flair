/**
 * mcp-tools-list-hook-bounds-2799.test.ts — flair#2799.
 *
 * The two test-only read-failure hooks of the /mcp sub→principal resolution
 * (flair#2794: the IdP credential read and the mapped principal's Agent read)
 * remember which (setting, subject) pairs already fired, so each pair fails
 * once. That memory is process-lifetime; this test pins its bound: past the
 * limit the hook stops firing for every further pair and says so once, and the
 * set stops growing. An empty setting value is inert.
 *
 * The hook is driven through resolveAgentFromSub, the resolution path both
 * tools/list and tools/call take, with Harper's Credential and Agent tables
 * doubled: a subject with no Credential row and JIT provisioning off resolves
 * to null, so a throw can only come from the injected read failure.
 */
import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";

// ─── Harper double: one seeded mapping, no others ───────────────────────────
class NoopBase {
  constructor(_id?: any, _ctx?: any) {}
}
const MAPPED_SUB = "principal-bound-2799-a";
const MAPPED_PRINCIPAL = "agt-2799";
const credentials: any[] = [
  { id: "cred-2799", kind: "idp", idpSubject: MAPPED_SUB, principalId: MAPPED_PRINCIPAL, status: "active" },
];
const principal = { id: MAPPED_PRINCIPAL, status: "active" };
const databasesMock = {
  flair: {
    Credential: Object.assign(class extends NoopBase {}, {
      search: async function* (query: any) {
        for (const row of credentials) {
          if ((query?.conditions ?? []).every((c: any) => row?.[c.attribute] === c.value)) yield row;
        }
      },
      get: async (id: string) => credentials.find((row) => row.id === id) ?? null,
      patch: async () => undefined,
    }),
    Agent: Object.assign(class extends NoopBase {}, {
      get: async (id: string) => (id === MAPPED_PRINCIPAL ? principal : null),
    }),
  },
};
mock.module("harper", () => ({
  databases: databasesMock,
  Resource: NoopBase,
  server: { http: () => {}, getUser: async () => null },
}));

const {
  resolveAgentFromSub,
  testReadFailure,
  testReadFailureFiredCount,
  TEST_READ_FAILURE_FIRED_LIMIT,
} = await import("../../resources/mcp-handler.ts");

const CREDENTIAL_SETTING = "FLAIR_TEST_MCP_CREDENTIAL_READ_FAIL_SUB";
const PRINCIPAL_SETTING = "FLAIR_TEST_MCP_PRINCIPAL_READ_FAIL_SUB";
const GATE = "FLAIR_ENABLE_TEST_FAULT_INJECTION";

const SAVED: Record<string, string | undefined> = {};
const SETTINGS = [GATE, CREDENTIAL_SETTING, PRINCIPAL_SETTING, "FLAIR_MCP_JIT_PROVISION"];

beforeEach(() => {
  for (const name of SETTINGS) SAVED[name] = process.env[name];
  process.env[GATE] = "1";
  delete process.env.FLAIR_MCP_JIT_PROVISION;
  delete process.env[CREDENTIAL_SETTING];
  delete process.env[PRINCIPAL_SETTING];
});

afterEach(() => {
  for (const name of SETTINGS) {
    if (SAVED[name] === undefined) delete process.env[name];
    else process.env[name] = SAVED[name];
  }
});

describe("the read-failure hooks' fired state is bounded (flair#2799)", () => {
  test("an empty setting value is inert for both hooks", async () => {
    process.env[CREDENTIAL_SETTING] = "";
    process.env[PRINCIPAL_SETTING] = "";
    const before = testReadFailureFiredCount();
    expect(testReadFailure(CREDENTIAL_SETTING, "a-subject")).toBe(false);
    expect(testReadFailure(PRINCIPAL_SETTING, "a-subject")).toBe(false);
    // Through the resolver: no fault, so the unknown subject simply has no mapping.
    expect(await resolveAgentFromSub("a-subject")).toBeNull();
    expect(testReadFailureFiredCount()).toBe(before);
  }, 30_000);

  test("a mapped subject's principal read fails once, then the mapping resolves", async () => {
    process.env[PRINCIPAL_SETTING] = "principal-bound-2799";
    const first: any = await resolveAgentFromSub(MAPPED_SUB).then(
      () => null,
      (e: unknown) => e,
    );
    expect(first?.message).toContain(`the status of principal '${MAPPED_PRINCIPAL}' could not be read`);
    // The same subject again: the hook has fired for that pair, so the mapping
    // resolves to the seeded principal.
    expect(await resolveAgentFromSub(MAPPED_SUB)).toEqual({ agentId: MAPPED_PRINCIPAL, isAdmin: false });
  }, 30_000);

  // Last in the file: it fills the fired set, so no later test here may depend on
  // a fresh set.
  test("past the limit the hook stops firing, logs once, and the set stops growing", async () => {
    process.env[CREDENTIAL_SETTING] = "bound-2799";
    const logged: string[] = [];
    const realWarn = console.warn;
    console.warn = (...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    };
    try {
      const filled = testReadFailureFiredCount();
      // Fill the set to its limit: every distinct subject fails once.
      for (let i = filled; i < TEST_READ_FAILURE_FIRED_LIMIT; i++) {
        const err: any = await resolveAgentFromSub(`bound-2799-${i}`).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err?.message, `subject ${i} did not fail`).toContain(
          "the credential for this token's subject could not be read",
        );
      }
      expect(testReadFailureFiredCount()).toBe(TEST_READ_FAILURE_FIRED_LIMIT);

      // Past the limit the hook is inert and the set stays where it is.
      for (let i = 0; i < 8; i++) {
        const sub = `bound-2799-over-${i}`;
        expect(testReadFailure(CREDENTIAL_SETTING, sub)).toBe(false);
        expect(await resolveAgentFromSub(sub)).toBeNull();
      }
      expect(testReadFailureFiredCount()).toBe(TEST_READ_FAILURE_FIRED_LIMIT);
      expect(logged.length, `expected one limit log, got ${JSON.stringify(logged)}`).toBe(1);
      expect(logged[0]).toContain(`${TEST_READ_FAILURE_FIRED_LIMIT}-pair limit`);
    } finally {
      console.warn = realWarn;
    }
  }, 60_000);
});
