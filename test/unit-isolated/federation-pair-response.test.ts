/**
 * federation-pair-response.test.ts — flair#822
 *
 * Drives the real FederationPair.post() against a mocked Harper so the
 * pair JSON includes `instance {id, publicKey}` when the hub has an
 * Instance row, and returns 503 (without consuming the token) when it
 * does not.
 *
 * Isolated: harper mock + Federation.ts module init must not leak.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.ts";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";

const HUB_ID = "flair_hubpair822";
const HUB_KEY = Buffer.from("hub-public-key-32-bytes-pad!!!!").toString("base64url");

let instanceRow: Record<string, unknown> | null = {
  id: HUB_ID,
  publicKey: HUB_KEY,
  role: "hub",
  status: "active",
};
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
      search: () => asyncRows(instanceRow ? [instanceRow] : []),
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
const { HUB_IDENTITY_INCOMPLETE } = await import("../../src/lib/federation-pair-identity.ts");

function spokeSignedBody(pairingToken: string) {
  const kp = nacl.sign.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString("base64url");
  return signBodyFresh(
    {
      instanceId: `flair_spoke_${Buffer.from(nacl.randomBytes(4)).toString("hex")}`,
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
  instanceRow = {
    id: HUB_ID,
    publicKey: HUB_KEY,
    role: "hub",
    status: "active",
  };
  peers.clear();
  tokens.clear();
});

describe("FederationPair.post — instance {id, publicKey} (flair#822)", () => {
  it("successful pair includes instance {id, publicKey}", async () => {
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
    expect(peers.get(body.instanceId)?.publicKey).toBe(body.publicKey);
  });

  it("missing hub Instance → 503 hub_instance_identity_incomplete; token not consumed", async () => {
    instanceRow = null;
    const token = "pair-token-no-hub-instance";
    tokens.set(token, {
      id: token,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await makePair().post(spokeSignedBody(token));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
    const json = await readBody(result);
    expect(json.error).toBe(HUB_IDENTITY_INCOMPLETE);
    expect(tokens.get(token)?.consumedBy).toBeUndefined();
    expect(peers.size).toBe(0);
  });

  it("hub Instance with empty publicKey → 503; does not write a peer", async () => {
    instanceRow = { id: HUB_ID, publicKey: "", role: "hub" };
    const token = "pair-token-empty-hub-key";
    tokens.set(token, {
      id: token,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await makePair().post(spokeSignedBody(token));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
    const json = await readBody(result);
    expect(json.error).toBe(HUB_IDENTITY_INCOMPLETE);
    expect(peers.size).toBe(0);
  });

  it("re-pair of an existing peer still returns instance {id, publicKey}", async () => {
    const body = spokeSignedBody("unused-on-repair");
    peers.set(body.instanceId, {
      id: body.instanceId,
      publicKey: body.publicKey,
      role: "spoke",
      status: "paired",
    });
    const result = await makePair().post(body);
    const json = await readBody(result);
    expect(json.paired).toBe(true);
    expect(json.instance.id).toBe(HUB_ID);
    expect(json.instance.publicKey).toBe(HUB_KEY);
  });
});
