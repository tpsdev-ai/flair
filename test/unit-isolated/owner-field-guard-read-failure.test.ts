// owner-field-guard-read-failure.test.ts
//
// The shared owner-field guard (resources/owner-field-guard.ts) reads the stored
// record through a `getExisting` thunk. A read that RESOLVED to null/undefined is
// "no stored record" (a create, which the rule leaves alone). A read that THREW
// or rejected is a FAILURE: the guard must refuse with a named refusal, never
// read the failure as "no stored record" and let the write through.
//
// The refusal STATUS is chosen by the error: a client-status error (`statusCode`
// in 400..499, e.g. a 404 from a bad id) answers 400 — a retry with the same
// input fails the same way; anything else answers 503, since a retry can
// succeed. Both are refusals (`owner_check_unavailable`) and the write does not
// happen.
//
// This exercises the guard's OWN read. On the HTTP path a real Harper loads the
// row before the resource runs and a no-arg `super.get()` returns the cached
// record, so this seam is reachable only off that path (in-process calls, or a
// resource that reads the row itself). The real-Harper behaviour — an unreadable
// row is refused one layer up with Harper's own 500 — is measured in
// test/integration/owner-guard-2468-real-harper-load.test.ts.
//
// Lives in test/unit-isolated/ because importing the guard pulls in the auth
// helper, which imports "harper"; this file mocks that module so the real
// Harper package is never opened in-process.
import { mock, describe, test, expect } from "bun:test";

mock.module("harper", () => ({
  databases: { flair: {} },
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  models: {},
  createBlob: () => ({}),
  getContext: () => undefined,
  tables: {},
}));

const { guardOwnerFieldImmutable, OWNER_CHECK_UNAVAILABLE_ERROR } = await import(
  "../../resources/owner-field-guard.js"
);

/** A `self` whose context resolves to a non-admin agent. */
const agentSelf = () => ({ getContext: () => ({ tpsAgent: "agent-a", tpsAgentIsAdmin: false }) });

describe("the owner-field guard refuses a write whose stored-row read FAILS", () => {
  test("a rejecting getExisting returns the named refusal (503 owner_check_unavailable)", async () => {
    const res = await guardOwnerFieldImmutable(
      agentSelf(),
      () => Promise.reject(new Error("injected stored-row read failure")),
      { agentId: "agent-b" },
      "agentId",
    );
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.error).toBe(OWNER_CHECK_UNAVAILABLE_ERROR);
    expect(OWNER_CHECK_UNAVAILABLE_ERROR).toBe("owner_check_unavailable");
  });

  test("a synchronously throwing getExisting is refused too (not propagated as a throw)", async () => {
    const res = await guardOwnerFieldImmutable(
      agentSelf(),
      () => { throw new Error("injected synchronous stored-row read failure"); },
      { agentId: "agent-b" },
      "agentId",
    );
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(503);
  });

  test("a client-status read error answers 400 (still a refusal)", async () => {
    const err = Object.assign(new Error("bad id"), { statusCode: 404 });
    const res = await guardOwnerFieldImmutable(agentSelf(), () => Promise.reject(err), { agentId: "agent-b" }, "agentId");
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
  });
});

describe("an absent stored row keeps today's behaviour (a create is not this rule's business)", () => {
  test("a resolving null proceeds (returns null)", async () => {
    expect(await guardOwnerFieldImmutable(agentSelf(), () => Promise.resolve(null), { agentId: "agent-b" }, "agentId")).toBeNull();
  });

  test("a resolving undefined proceeds (returns null)", async () => {
    expect(await guardOwnerFieldImmutable(agentSelf(), () => undefined, { agentId: "agent-b" }, "agentId")).toBeNull();
  });
});

describe("a stored row keeps today's behaviour", () => {
  test("a write that does not change the owner field proceeds", async () => {
    const row = { agentId: "agent-a", content: "stored" };
    expect(await guardOwnerFieldImmutable(agentSelf(), () => row, { content: "changed" }, "agentId")).toBeNull();
  });

  test("a write that changes the owner field is refused (403)", async () => {
    const row = { agentId: "agent-a", content: "stored" };
    const res = await guardOwnerFieldImmutable(agentSelf(), () => row, { agentId: "agent-b" }, "agentId");
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(403);
  });
});

describe("admin and internal callers are unchanged", () => {
  test("an admin agent proceeds even when the read would fail", async () => {
    const self = { getContext: () => ({ tpsAgent: "agent-a", tpsAgentIsAdmin: true }) };
    expect(await guardOwnerFieldImmutable(self, () => Promise.reject(new Error("boom")), { agentId: "agent-b" }, "agentId")).toBeNull();
  });

  test("an internal caller proceeds even when the read would fail", async () => {
    expect(await guardOwnerFieldImmutable({ getContext: () => null }, () => Promise.reject(new Error("boom")), { agentId: "agent-b" }, "agentId")).toBeNull();
  });
});
