/**
 * federation-pair-response.test.ts — flair#822
 *
 * Flint: pair already returns `instance.{id,publicKey}` when the hub has
 * an Instance row. `instance: null` means no FederationInstance (#839).
 * This file guards that existing response shape so #822 stays a spoke
 * fail-closed chip, not a hub-row provision.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.ts";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

const HUB_ID = "flair_hubpair822";
const HUB_KEY = Buffer.from("hub-public-key-32-bytes-pad!!!!").toString("base64url");

let instanceRows: Record<string, unknown>[] = [
  {
    id: HUB_ID,
    publicKey: HUB_KEY,
    role: "hub",
    status: "active",
  },
];
const peers = new Map<string, Record<string, unknown>>();
const tokens = new Map<string, Record<string, unknown>>();

function asyncRows<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

const databasesMock = {
  flair: {
    Instance: {
      search: () => asyncRows(instanceRows),
    },
    Peer: {
      get: async (id: string) => peers.get(id) ?? null,
      put: async (row: Record<string, unknown>) => {
        peers.set(String(row.id), { ...row });
        return row;
      },
    },
    PairingToken: {
      get: async (id: string) => tokens.get(id) ?? null,
      put: async (row: Record<string, unknown>) => {
        tokens.set(String(row.id), { ...row });
        return row;
      },
    },
    Nonce: {
      search: () => asyncRows([]),
      put: async () => undefined,
      get: async () => null,
    },
  },
};

mock.module("harper", () => ({
  databases: databasesMock,
  Resource: class {},
  server: {
    getUser: async () => null,
    operation: async () => ({}),
    http: () => {},
  },
}));

const { FederationPair } = await import("../../resources/Federation.ts");

function spokeSignedBody(
  pairingToken: string,
  opts: { instanceId?: string; keyPair?: nacl.SignKeyPair } = {},
) {
  const kp = opts.keyPair ?? nacl.sign.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString("base64url");
  return signBodyFresh(
    {
      instanceId: opts.instanceId ?? `flair_spoke_${Buffer.from(nacl.randomBytes(4)).toString("hex")}`,
      publicKey,
      role: "spoke",
      pairingToken,
    },
    kp.secretKey,
  );
}

function makePair() {
  const pair: any = new (FederationPair as any)();
  pair.getContext = () => ({ request: {} });
  return pair;
}

async function readBody(result: unknown): Promise<any> {
  if (result instanceof Response) return result.json();
  return result;
}

beforeEach(() => {
  instanceRows = [
    {
      id: HUB_ID,
      publicKey: HUB_KEY,
      role: "hub",
      status: "active",
    },
  ];
  peers.clear();
  tokens.clear();
});

describe("FederationPair.post — existing instance.{id,publicKey} shape (flair#213 / #822)", () => {
  it("includes instance {id, publicKey} when the hub has an Instance row", async () => {
    const token = "pair-token-complete-identity";
    tokens.set(token, {
      id: token,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const body = spokeSignedBody(token);
    const result = await makePair().post(body);
    expect(result).not.toBeInstanceOf(Response);
    const json = await readBody(result);
    expect(json.paired).toBe(true);
    expect(json.instance).toEqual({
      id: HUB_ID,
      publicKey: HUB_KEY,
      role: "hub",
    });
    expect(json.instance.publicKey).not.toBe("");
  });

  it("returns instance:null when the hub has no FederationInstance — does not invent a key (#839)", async () => {
    instanceRows = [];
    const token = "pair-token-no-hub-instance";
    tokens.set(token, {
      id: token,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await makePair().post(spokeSignedBody(token));
    expect(result).not.toBeInstanceOf(Response);
    const json = await readBody(result);
    expect(json.paired).toBe(true);
    expect(json.instance).toBeNull();
  });
});

describe("FederationPair.post — several Instance rows refuse BEFORE the token, the peer read and every peer write (flair#1883 round 3)", () => {
  const ROW_A = { id: "flair_pair_row_a", publicKey: "key-a", role: "spoke", status: "active" };
  const ROW_B = { id: "flair_pair_row_b", publicKey: "key-b", role: "hub", status: "active" };

  // Both table orders: the defect was that the response depended on which row the
  // search yielded first, so the same two rows are fed both ways.
  for (const [label, order] of [
    ["row A first", [ROW_A, ROW_B]],
    ["row B first", [ROW_B, ROW_A]],
  ] as const) {
    it(`${label}: answers 409 naming both rows and the prune, consumes NO token and writes NO peer`, async () => {
      instanceRows = [...order];
      const token = `pair-token-multiple-${label.replace(/ /g, "-")}`;
      tokens.set(token, { id: token, expiresAt: new Date(Date.now() + 60_000).toISOString() });

      const result = await makePair().post(spokeSignedBody(token));

      expect(result).toBeInstanceOf(Response);
      const res = result as Response;
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("multiple_instance_rows");
      expect(json.detail).toContain(ROW_A.id);
      expect(json.detail).toContain(ROW_B.id);
      expect(json.detail).toContain("flair federation instance prune");
      expect(json.detail).toContain("--apply");
      expect(json.rows.map((r: any) => r.id)).toEqual(order.map((r: any) => r.id));

      // The check ran FIRST: the one-time token is still usable...
      expect(tokens.get(token)?.consumedBy).toBeUndefined();
      expect(tokens.get(token)?.consumedAt).toBeUndefined();
      // ...and no peer was recorded from a pairing that did not happen.
      expect(peers.size).toBe(0);
    });
  }

  it("refuses a RE-PAIR the same way, leaving the existing peer row untouched", async () => {
    // A re-pair needs no token and WRITES the existing peer row (endpoint/status)
    // — so the refusal has to come before that write too.
    instanceRows = [ROW_A, ROW_B];
    const instanceId = "flair_spoke_already_paired";
    const kp = nacl.sign.keyPair();
    const publicKey = Buffer.from(kp.publicKey).toString("base64url");
    const before = {
      id: instanceId,
      publicKey,
      role: "spoke",
      endpoint: "http://spoke.example:9926",
      status: "paired",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    peers.set(instanceId, { ...before });

    const result = await makePair().post(
      spokeSignedBody("unused-for-a-repair", { instanceId, keyPair: kp }),
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(409);
    expect(peers.get(instanceId)).toEqual(before);
  });

  it("still pairs normally with exactly one row — the refusal is about several", async () => {
    const token = "pair-token-one-row";
    tokens.set(token, { id: token, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const json = await readBody(await makePair().post(spokeSignedBody(token)));
    expect(json.paired).toBe(true);
    expect(json.instance).toEqual({ id: HUB_ID, publicKey: HUB_KEY, role: "hub" });
    // The happy path still consumes the token — proof the refusal above is the
    // thing that skips it, not a change to pairing itself.
    expect(tokens.get(token)?.consumedBy).toBeTruthy();
  });

  it("answers 5xx for a table serving an unnameable row — consumes NO token and writes NO peer", async () => {
    // flair#1883 round 4: a malformed row is not a missing row. The reader used to
    // SKIP an entry without a usable id, so a table of [{}] (or a good row beside
    // it) read as "the rows I could name" and this endpoint could answer a peer
    // with an identity it never read — or pair against none at all.
    instanceRows = [{}, { id: "flair_good", role: "hub" }];
    const token = "pair-token-unnameable-row";
    tokens.set(token, { id: token, expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const result = await makePair().post(spokeSignedBody(token));

    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
    const json = await res.json();
    expect(json.error).toBe("instance_identity_unreadable");
    // The pairing did not happen: the one-time token is unused and no peer was
    // recorded.
    expect(tokens.get(token)?.consumedBy).toBeUndefined();
    expect(peers.size).toBe(0);
  });
});
