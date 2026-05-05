import { describe, it, expect, mock, beforeEach } from "bun:test";

// ─── Handshake validator — extracted logic for unit testing ────────────────

type TpsContext = {
  request?: {
    tpsAgent?: string;
    tpsAgentIsAdmin?: boolean;
  };
};

function validateBootstrapUser(
  pairingToken: string,
  ctx: TpsContext | null | undefined,
): { ok: true } | { ok: false; error: string; status: number } {
  const authedUser = ctx?.request?.tpsAgent;
  const isAdmin = ctx?.request?.tpsAgentIsAdmin === true;

  if (!isAdmin && authedUser) {
    const expectedBootstrap = `pair-bootstrap-${pairingToken.slice(0, 8)}`;
    if (authedUser !== expectedBootstrap) {
      return { ok: false, error: "bootstrap_user_token_mismatch", status: 401 };
    }
  }

  return { ok: true };
}

// ─── Mock token store ──────────────────────────────────────────────────────

interface TokenRecord {
  id: string;
  consumedBy?: string;
  expiresAt: string;
}

interface PeerRecord {
  id: string;
  publicKey: string;
  role: string;
  status: string;
  pairedAt: string;
}

function simulatePairHandshake(opts: {
  pairingToken: string;
  instanceId: string;
  publicKey: string;
  ctx: TpsContext | null | undefined;
  tokenStore: Map<string, TokenRecord>;
  peerStore: Map<string, PeerRecord>;
}): { ok: true; peer: PeerRecord; consumedTokenId: string | null } | { ok: false; error: string; status: number } {
  const { pairingToken, instanceId, publicKey, ctx, tokenStore, peerStore } = opts;

  // Step 1: Look up token record
  const tokenRecord = tokenStore.get(pairingToken);
  if (!tokenRecord || tokenRecord.consumedBy) {
    return { ok: false, error: "invalid_or_expired_pairing_token", status: 401 };
  }
  if (new Date(tokenRecord.expiresAt) < new Date()) {
    return { ok: false, error: "invalid_or_expired_pairing_token", status: 401 };
  }

  // Step 2: PR-4 — validate bootstrap user bound to this token
  const validation = validateBootstrapUser(pairingToken, ctx);
  if (!validation.ok) {
    // Token NOT consumed — DoS protection
    return validation;
  }

  // Step 3: Consume the token
  tokenStore.set(pairingToken, {
    ...tokenRecord,
    consumedBy: instanceId,
  });

  // Step 4: Create peer
  const peer: PeerRecord = {
    id: instanceId,
    publicKey,
    role: "spoke",
    status: "paired",
    pairedAt: new Date().toISOString(),
  };
  peerStore.set(instanceId, peer);

  return { ok: true, peer, consumedTokenId: pairingToken };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("federation pair handshake — bootstrap user validation (PR-4)", () => {
  let tokenStore: Map<string, TokenRecord>;
  let peerStore: Map<string, PeerRecord>;
  const TOKEN = "aB3xK9mNpQrSvWyZ"; // 16 chars
  const INSTANCE = "spoke_abc123";

  beforeEach(() => {
    tokenStore = new Map();
    peerStore = new Map();

    // Seed a valid, unconsumed token
    tokenStore.set(TOKEN, {
      id: TOKEN,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  });

  // ── Test 1: Bootstrap user matches token → accepted, peer created ───────

  it("bootstrap user matches token → accepted, peer created", () => {
    const result = simulatePairHandshake({
      pairingToken: TOKEN,
      instanceId: INSTANCE,
      publicKey: "pubkey_spoke_abc123",
      ctx: {
        request: {
          tpsAgent: `pair-bootstrap-${TOKEN.slice(0, 8)}`,
        },
      },
      tokenStore,
      peerStore,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.peer.id).toBe(INSTANCE);
      expect(result.peer.status).toBe("paired");

      // Token was consumed
      const consumed = tokenStore.get(TOKEN);
      expect(consumed?.consumedBy).toBe(INSTANCE);
    }
  });

  // ── Test 2: Bootstrap user mismatched → 401, not consumed ──────────────

  it("bootstrap user mismatched → 401, no peer, token NOT consumed", () => {
    const result = simulatePairHandshake({
      pairingToken: TOKEN,
      instanceId: INSTANCE,
      publicKey: "pubkey_spoke_abc123",
      ctx: {
        request: {
          tpsAgent: "pair-bootstrap-WRONG999", // doesn't match token
        },
      },
      tokenStore,
      peerStore,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("bootstrap_user_token_mismatch");
    }

    // Token was NOT consumed (DoS protection)
    const tokenAfter = tokenStore.get(TOKEN);
    expect(tokenAfter?.consumedBy).toBeUndefined();

    // No peer created
    expect(peerStore.has(INSTANCE)).toBe(false);
  });

  it("bootstrap user mismatched — completely wrong username format", () => {
    const result = simulatePairHandshake({
      pairingToken: TOKEN,
      instanceId: INSTANCE,
      publicKey: "pubkey_spoke_abc123",
      ctx: {
        request: {
          tpsAgent: "admin", // not a bootstrap user at all
        },
      },
      tokenStore,
      peerStore,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("bootstrap_user_token_mismatch");
    }

    // Token NOT consumed
    expect(tokenStore.get(TOKEN)?.consumedBy).toBeUndefined();
    expect(peerStore.has(INSTANCE)).toBe(false);
  });

  it("bootstrap user mismatched — correct prefix but wrong token", () => {
    const result = simulatePairHandshake({
      pairingToken: TOKEN,
      instanceId: INSTANCE,
      publicKey: "pubkey_spoke_abc123",
      ctx: {
        request: {
          tpsAgent: "pair-bootstrap-WRONG111", // prefix right, token part wrong
        },
      },
      tokenStore,
      peerStore,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }

    expect(tokenStore.get(TOKEN)?.consumedBy).toBeUndefined();
    expect(peerStore.has(INSTANCE)).toBe(false);
  });

  // ── Test 3: Admin user accepted (legacy path) ───────────────────────────

  it("admin user (tpsAgentIsAdmin=true) → accepted (legacy path)", () => {
    const result = simulatePairHandshake({
      pairingToken: TOKEN,
      instanceId: INSTANCE,
      publicKey: "pubkey_spoke_abc123",
      ctx: {
        request: {
          tpsAgent: "admin",
          tpsAgentIsAdmin: true,
        },
      },
      tokenStore,
      peerStore,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.peer.status).toBe("paired");
    }

    // Token was consumed
    expect(tokenStore.get(TOKEN)?.consumedBy).toBe(INSTANCE);
    expect(peerStore.has(INSTANCE)).toBe(true);
  });

  it("admin user (tpsAgentIsAdmin=true) accepted even with wrong bootstrap username", () => {
    const result = simulatePairHandshake({
      pairingToken: TOKEN,
      instanceId: INSTANCE,
      publicKey: "pubkey_spoke_abc123",
      ctx: {
        request: {
          tpsAgent: "some_weird_user",
          tpsAgentIsAdmin: true,
        },
      },
      tokenStore,
      peerStore,
    });

    // Admin bypasses the bootstrap check entirely
    expect(result.ok).toBe(true);
    expect(tokenStore.get(TOKEN)?.consumedBy).toBe(INSTANCE);
  });

  // ── Test 4: No authedUser → accepted (admin/dev direct path) ───────────

  it("no authedUser → accepted (admin/dev direct path)", () => {
    const result = simulatePairHandshake({
      pairingToken: TOKEN,
      instanceId: INSTANCE,
      publicKey: "pubkey_spoke_abc123",
      ctx: null,
      tokenStore,
      peerStore,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.peer.status).toBe("paired");
    }

    expect(tokenStore.get(TOKEN)?.consumedBy).toBe(INSTANCE);
    expect(peerStore.has(INSTANCE)).toBe(true);
  });

  it("no authedUser — empty context object → accepted", () => {
    const result = simulatePairHandshake({
      pairingToken: TOKEN,
      instanceId: INSTANCE,
      publicKey: "pubkey_spoke_abc123",
      ctx: {},
      tokenStore,
      peerStore,
    });

    expect(result.ok).toBe(true);
    expect(tokenStore.get(TOKEN)?.consumedBy).toBe(INSTANCE);
    expect(peerStore.has(INSTANCE)).toBe(true);
  });

  it("no authedUser — ctx with request but no tpsAgent → accepted", () => {
    const result = simulatePairHandshake({
      pairingToken: TOKEN,
      instanceId: INSTANCE,
      publicKey: "pubkey_spoke_abc123",
      ctx: { request: {} },
      tokenStore,
      peerStore,
    });

    expect(result.ok).toBe(true);
    expect(tokenStore.get(TOKEN)?.consumedBy).toBe(INSTANCE);
    expect(peerStore.has(INSTANCE)).toBe(true);
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe("federation pair handshake — edge cases", () => {
  let tokenStore: Map<string, TokenRecord>;
  let peerStore: Map<string, PeerRecord>;
  const TOKEN = "shortToken";

  beforeEach(() => {
    tokenStore = new Map();
    peerStore = new Map();

    tokenStore.set(TOKEN, {
      id: TOKEN,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  });

  it("handles tokens shorter than 8 chars gracefully", () => {
    // token.slice(0, 8) on a short token returns the whole token
    const result = simulatePairHandshake({
      pairingToken: "short",
      instanceId: "spoke_x",
      publicKey: "pk",
      ctx: {
        request: {
          tpsAgent: `pair-bootstrap-short`,
        },
      },
      tokenStore: new Map([
        ["short", { id: "short", expiresAt: new Date(Date.now() + 3600_000).toISOString() }],
      ]),
      peerStore,
    });

    expect(result.ok).toBe(true);
  });

  it("bootstrap user match is exact — substring match is not sufficient", () => {
    const result = simulatePairHandshake({
      pairingToken: TOKEN,
      instanceId: "spoke_x",
      publicKey: "pk",
      ctx: {
        request: {
          tpsAgent: `pair-bootstrap-${TOKEN.slice(0, 8)}_extra`,
        },
      },
      tokenStore,
      peerStore,
    });

    // The bootstrap username has extra chars — must be exact match
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }

    expect(tokenStore.get(TOKEN)?.consumedBy).toBeUndefined();
  });
});
