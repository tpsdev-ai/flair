/**
 * `GET /FederationInstance` must not invent an identity (flair#1883 round 2).
 *
 * The resource's create branch is the ONLY writer of a fresh `flair.Instance`
 * row, and it used to run after ANY read failure — the old code logged
 * "proceeding as first boot" and fell through. On a persistent storage or
 * permission failure the GET then minted a new row on every call, so a hub could
 * hold several identities and which one it reported depended on which row
 * `search()` yielded first. That is the defect #1883 exists to end, reached from
 * the other side.
 *
 * So: a read that FAILS is an error (5xx, create nothing), and only a SUCCESSFUL
 * read that returns zero rows creates. Both are asserted here against the real
 * resource with a mocked harper, because there is no way to make a live Harper's
 * Instance read fail on demand.
 *
 * Own process (test/unit-isolated) so this harper mock never races another file's.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

type ReadBehaviour = "throw" | "empty" | "rows";
let readBehaviour: ReadBehaviour = "empty";
let rowsToServe: any[] = [];
const puts: any[] = [];

const databasesMock = {
  flair: {
    Instance: {
      search: () => {
        async function* gen() {
          if (readBehaviour === "throw") throw new Error("rocksdb: IO error while opening the Instance table");
          for (const row of rowsToServe) yield row;
        }
        return gen();
      },
      put: async (record: any) => {
        puts.push(record);
        return record;
      },
    },
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  Resource: class {},
  server: { getUser: async () => null, operation: async () => null },
}));

const { FederationInstance } = await import("../../resources/Federation.ts");

function makeInstance() {
  return new (FederationInstance as any)();
}

beforeEach(() => {
  readBehaviour = "empty";
  rowsToServe = [];
  puts.length = 0;
});

describe("FederationInstance.get() — a failed read is an error, not first boot", () => {
  it("answers 5xx and creates NOTHING when the Instance read throws", async () => {
    readBehaviour = "throw";

    const res = await makeInstance().get();

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
    const body = await res.json();
    expect(body.error).toBe("instance_identity_unreadable");
    // The whole point: no identity was minted on a read that did not happen.
    expect(puts).toHaveLength(0);
  });

  it("creates exactly one spoke row when a successful read finds no rows", async () => {
    readBehaviour = "empty";

    const identity = await makeInstance().get();

    expect(identity.role).toBe("spoke");
    expect(typeof identity.id).toBe("string");
    expect(identity.id.startsWith("flair_")).toBe(true);
    expect(typeof identity.publicKey).toBe("string");
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ id: identity.id, publicKey: identity.publicKey, role: "spoke" });
  });

  it("creates nothing when a successful read finds a row, and reports that row", async () => {
    readBehaviour = "rows";
    rowsToServe = [{ id: "flair_existing", publicKey: "existing-key", role: "hub", status: "active" }];

    const identity = await makeInstance().get();

    expect(identity.id).toBe("flair_existing");
    expect(identity.publicKey).toBe("existing-key");
    expect(identity.role).toBe("hub");
    expect(puts).toHaveLength(0);
  });
});
