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
    instanceRow = null;
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
