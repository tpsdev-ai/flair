/**
 * IngestEvents.ts — Observatory ingestion endpoint.
 *
 * POST /IngestEvents
 * Auth: TPS-Ed25519 signed by the office's private key (verified against
 *       ObsOffice.publicKey stored at registration time).
 *
 * Body: {
 *   officeId: string;
 *   events:   OrgEventRecord[];
 *   agents:   AgentStatus[];
 *   syncedAt: string;
 * }
 *
 * Actions:
 *   1. Verify Ed25519 signature against stored office public key
 *   2. Upsert ObsAgentSnapshot for each agent
 *   3. Insert ObsEventFeed for each new event (30-day TTL)
 *   4. Update ObsOffice.lastSeen + agentCount
 *
 * Rate limit: 1 call / 10s per office (enforced by createdAt delta check)
 * Batch limit: 100 events per call
 */

import { Resource, databases } from "@harperfast/harper";
import { createPublicKey, verify } from "node:crypto";

const BATCH_LIMIT = 100;
const RATE_LIMIT_MS = 10_000;
const EVENT_TTL_DAYS = 30;

interface OrgEventRecord {
  id: string;
  kind: string;
  authorId: string;
  summary: string;
  refId?: string;
  scope?: string;
  targetIds?: string[];
  createdAt: string;
}

interface AgentStatus {
  agentId: string;
  name?: string;
  role?: string;
  status?: string;
  model?: string;
  lastSeen?: string;
}

interface IngestPayload {
  officeId: string;
  events: OrgEventRecord[];
  agents: AgentStatus[];
  syncedAt: string;
}

function verifyEd25519Signature(
  publicKeyHex: string,
  authHeader: string,
  officeId: string,
): boolean {
  try {
    // Header format: TPS-Ed25519 officeId:ts:nonce:sig
    const prefix = "TPS-Ed25519 ";
    if (!authHeader.startsWith(prefix)) return false;
    const parts = authHeader.slice(prefix.length).split(":");
    if (parts.length < 4) return false;
    const [id, ts, nonce, ...sigParts] = parts;
    const sig = sigParts.join(":");
    if (id !== officeId) return false;

    // Replay protection: reject signatures older than 5 minutes
    const age = Date.now() - Number(ts);
    if (age > 5 * 60 * 1000 || age < -30_000) return false;

    const pubKeyBytes = Buffer.from(publicKeyHex.replace(/=\s*/g, ""), "hex");
    const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
    const pubKey = createPublicKey({ key: Buffer.concat([spkiHeader, pubKeyBytes]), format: "der", type: "spki" });

    const payload = Buffer.from(`${id}:${ts}:${nonce}:POST:/IngestEvents`);
    const sigBuf = Buffer.from(sig, "base64");
    return verify(null, payload, pubKey, sigBuf);
  } catch {
    return false;
  }
}

export class IngestEvents extends Resource {
  async post(body: unknown, context?: unknown) {
    const request = (this as any).request;
    const authHeader: string | undefined = request?.headers?.get?.("authorization") ?? request?.headers?.authorization;

    // Parse and validate body
    let payload: IngestPayload;
    try {
      payload = (typeof body === "string" ? JSON.parse(body) : body) as IngestPayload;
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const { officeId, events = [], agents = [], syncedAt } = payload;
    if (!officeId) {
      return new Response(JSON.stringify({ error: "officeId required" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    // Look up the office
    const office = await (databases as any).flair.ObsOffice.get(officeId).catch(() => null);
    if (!office) {
      return new Response(JSON.stringify({ error: "office not registered — POST /ObsOffice first" }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    // Verify Ed25519 signature
    if (!authHeader || !verifyEd25519Signature(String(office.publicKey), authHeader, officeId)) {
      return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    // Rate limit check
    if (office.lastSeen) {
      const msSinceLastSync = Date.now() - new Date(office.lastSeen).getTime();
      if (msSinceLastSync < RATE_LIMIT_MS) {
        return new Response(JSON.stringify({ error: "rate limit: 1 call per 10s" }), { status: 429, headers: { "Content-Type": "application/json" } });
      }
    }

    // Batch limit
    if (events.length > BATCH_LIMIT) {
      return new Response(JSON.stringify({ error: `batch limit: max ${BATCH_LIMIT} events` }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + EVENT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Upsert agent snapshots
    for (const agent of agents) {
      if (!agent.agentId) continue;
      const snapshotId = `${officeId}:${agent.agentId}`;
      await (databases as any).flair.ObsAgentSnapshot.put({
        id: snapshotId,
        officeId,
        agentId: agent.agentId,
        name: agent.name ?? agent.agentId,
        role: agent.role,
        status: agent.status ?? "unknown",
        model: agent.model,
        lastActivity: agent.lastSeen ?? now,
        lastHeartbeat: now,
        updatedAt: now,
      }).catch((e: Error) => console.warn(`[IngestEvents] snapshot upsert failed for ${snapshotId}: ${e.message}`));
    }

    // Insert event feed entries (skip duplicates)
    let inserted = 0;
    for (const ev of events) {
      if (!ev.id || !ev.kind) continue;
      const feedId = `${officeId}:${ev.id}`;
      const existing = await (databases as any).flair.ObsEventFeed.get(feedId).catch(() => null);
      if (existing) continue;
      await (databases as any).flair.ObsEventFeed.put({
        id: feedId,
        officeId,
        kind: ev.kind,
        authorId: ev.authorId,
        summary: ev.summary,
        refId: ev.refId,
        scope: ev.scope,
        createdAt: ev.createdAt,
        receivedAt: now,
        expiresAt,
      }).catch((e: Error) => console.warn(`[IngestEvents] event insert failed for ${feedId}: ${e.message}`));
      inserted++;
    }

    // Update office lastSeen + agentCount
    await (databases as any).flair.ObsOffice.put({
      ...office,
      status: "online",
      lastSeen: now,
      agentCount: agents.length,
      updatedAt: now,
    }).catch(() => {});

    return new Response(JSON.stringify({ ok: true, events: inserted, agents: agents.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
