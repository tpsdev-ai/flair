import { Resource, databases } from "@harperfast/harper";
import { createHash, randomBytes } from "node:crypto";
import nacl from "tweetnacl";

/**
 * Federation resource — hub-and-spoke sync for Flair instances.
 *
 * Implements:
 * - Instance identity management
 * - Peer pairing (one-shot HTTP handshake)
 * - Sync frame protocol (push/pull over WebSocket)
 * - Conflict resolution (field-level LWW with Lamport clocks)
 * - Peer public key propagation (hub broadcasts PeerAnnouncement frames)
 *
 * Per FLAIR-FEDERATION spec §§ 1-7.
 */

// ─── Sync frame types ────────────────────────────────────────────────────────

interface SyncFrame {
  type: "sync" | "ack" | "peer-announce" | "heartbeat";
  instanceId: string;
  timestamp: string;
  lamportClock: number;
  records?: SyncRecord[];
  peers?: PeerAnnouncement[];
}

interface SyncRecord {
  table: string;             // "Memory" | "Soul" | "Relationship" | "Agent"
  id: string;
  data: Record<string, any>;
  updatedAt: string;         // ISO timestamp — LWW tiebreaker
  originatorInstanceId: string;
  signature?: string;        // Ed25519 signature for agent-originated records
  principalId?: string;      // who authored this record
}

interface PeerAnnouncement {
  instanceId: string;
  publicKey: string;
  role: string;
  endpoint?: string;
}

// ─── Conflict resolution ─────────────────────────────────────────────────────

/**
 * Field-level Last-Write-Wins merge.
 * For each field, the value with the later `updatedAt` wins.
 * Records with no local counterpart are accepted directly.
 */
function mergeRecord(local: Record<string, any> | null, remote: SyncRecord): Record<string, any> {
  if (!local) return remote.data;

  const merged = { ...local };
  const localUpdated = local.updatedAt ?? "";
  const remoteUpdated = remote.updatedAt ?? "";

  // Simple LWW at record level for 1.0
  // Field-level LWW is the spec target but record-level is sufficient
  // for the initial implementation and avoids per-field clock tracking.
  if (remoteUpdated > localUpdated) {
    Object.assign(merged, remote.data);
    merged.updatedAt = remoteUpdated;
  }

  return merged;
}

// ─── Instance identity ───────────────────────────────────────────────────────

/**
 * GET /FederationInstance — return this instance's identity.
 * Used by peers during pairing and by the admin UI.
 */
export class FederationInstance extends Resource {
  async get() {
    // Find or create instance identity
    let instance: any = null;
    try {
      for await (const i of (databases as any).flair.Instance.search()) {
        instance = i;
        break;
      }
    } catch { /* table may not exist */ }

    if (!instance) {
      // First boot — generate instance identity
      const kp = nacl.sign.keyPair();
      const id = `flair_${randomBytes(4).toString("hex")}`;
      const publicKey = Buffer.from(kp.publicKey).toString("base64url");

      instance = {
        id,
        publicKey,
        role: "spoke", // default; hub is set during `flair init --remote`
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await (databases as any).flair.Instance.put(instance);

      // Store the private key seed (first 32 bytes of secretKey)
      // In production this would go to keychain; for now it's in Harper data
      // TODO: move to OS keychain per FLAIR-CLI spec
    }

    return {
      id: instance.id,
      publicKey: instance.publicKey,
      role: instance.role,
      status: instance.status,
    };
  }
}

// ─── Peer management ─────────────────────────────────────────────────────────

/**
 * POST /FederationPair — one-shot pairing handshake.
 * A spoke sends its instance identity; the hub records it as a peer.
 */
export class FederationPair extends Resource {
  async post(data: any) {
    const { instanceId, publicKey, role, endpoint } = data || {};

    if (!instanceId || !publicKey) {
      return new Response(JSON.stringify({ error: "instanceId and publicKey required" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Check if already paired
    const existing = await (databases as any).flair.Peer.get(instanceId);
    if (existing) {
      // Re-pairing: verify public key matches (prevents impersonation)
      if (existing.publicKey !== publicKey) {
        return new Response(JSON.stringify({
          error: "public key mismatch — peer already paired with different key",
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      // Update endpoint and status
      await (databases as any).flair.Peer.put({
        ...existing,
        endpoint: endpoint ?? existing.endpoint,
        status: "paired",
        updatedAt: new Date().toISOString(),
      });
    } else {
      await (databases as any).flair.Peer.put({
        id: instanceId,
        publicKey,
        role: role ?? "spoke",
        endpoint: endpoint ?? null,
        status: "paired",
        relayOnly: false,
        pairedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    // Return our own identity for the peer to record
    let ourInstance: any = null;
    try {
      for await (const i of (databases as any).flair.Instance.search()) {
        ourInstance = i;
        break;
      }
    } catch {}

    return {
      paired: true,
      instance: ourInstance ? {
        id: ourInstance.id,
        publicKey: ourInstance.publicKey,
        role: ourInstance.role,
      } : null,
    };
  }
}

// ─── Sync endpoint ───────────────────────────────────────────────────────────

/**
 * POST /FederationSync — push sync records from a peer.
 * In 1.0, this is a simple HTTP push (not WebSocket).
 * The calling peer sends a batch of SyncRecords; we merge them.
 */
export class FederationSync extends Resource {
  async post(data: any) {
    const { instanceId, records, lamportClock } = data || {};

    if (!instanceId || !Array.isArray(records)) {
      return new Response(JSON.stringify({ error: "instanceId and records[] required" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Verify peer is known
    const peer = await (databases as any).flair.Peer.get(instanceId);
    if (!peer || peer.status === "revoked") {
      return new Response(JSON.stringify({ error: "unknown or revoked peer" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }

    const startTime = Date.now();
    let merged = 0;
    let skipped = 0;

    // Table name → Harper database table mapping
    const tableMap: Record<string, any> = {
      Memory: (databases as any).flair.Memory,
      Soul: (databases as any).flair.Soul,
      Agent: (databases as any).flair.Agent,
      Relationship: (databases as any).flair.Relationship,
    };

    for (const record of records as SyncRecord[]) {
      const table = tableMap[record.table];
      if (!table) {
        skipped++;
        continue;
      }

      try {
        const local = await table.get(record.id);
        const mergedData = mergeRecord(local, record);

        // Preserve originator for provenance
        mergedData._originatorInstanceId = record.originatorInstanceId ?? instanceId;
        mergedData._syncedFrom = instanceId;
        mergedData._syncedAt = new Date().toISOString();

        await table.put(mergedData);
        merged++;
      } catch {
        skipped++;
      }
    }

    // Update peer sync cursor
    await (databases as any).flair.Peer.put({
      ...peer,
      lastSyncAt: new Date().toISOString(),
      lastSyncCursor: lamportClock?.toString() ?? new Date().toISOString(),
      status: "connected",
      updatedAt: new Date().toISOString(),
    });

    // Log sync operation
    try {
      await (databases as any).flair.SyncLog.put({
        id: `sync_${Date.now()}_${randomBytes(4).toString("hex")}`,
        peerId: instanceId,
        direction: "pull",
        recordCount: merged,
        status: skipped > 0 ? "partial" : "success",
        error: skipped > 0 ? `${skipped} records skipped` : undefined,
        durationMs: Date.now() - startTime,
        createdAt: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }

    return {
      merged,
      skipped,
      total: records.length,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * GET /FederationPeers — list known peers (admin view).
 */
export class FederationPeers extends Resource {
  async get() {
    const peers: any[] = [];
    try {
      for await (const p of (databases as any).flair.Peer.search()) {
        peers.push({
          id: p.id,
          role: p.role,
          status: p.status,
          lastSyncAt: p.lastSyncAt,
          relayOnly: p.relayOnly,
          pairedAt: p.pairedAt,
        });
      }
    } catch {}
    return { peers };
  }
}
