/**
 * observatory-sync.ts — Flair → Observatory push plugin
 *
 * Polls local Flair for OrgEvents + agent statuses every syncIntervalMs,
 * then POSTs a batch to the Observatory IngestEvents endpoint with Ed25519 auth.
 *
 * Config (env vars or constructor options):
 *   OBSERVATORY_URL        — e.g. https://tps-observatory.harperdbcloud.com
 *   OBSERVATORY_OFFICE_ID  — e.g. "rockit"
 *   OBSERVATORY_KEY_PATH   — path to Ed25519 private key (raw 32-byte seed)
 *   FLAIR_URL              — local Flair base URL (default http://127.0.0.1:9926)
 *   OBSERVATORY_INTERVAL_MS — sync interval (default 60000)
 *
 * Usage:
 *   // Run as standalone script:
 *   bun ~/ops/flair/src/observatory-sync.ts
 *
 *   // Or import and start:
 *   import { ObservatorySync } from "./observatory-sync.js";
 *   const sync = new ObservatorySync({ officeId: "rockit", ... });
 *   await sync.start();
 */

import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface ObservatorySyncConfig {
  observatoryUrl: string;
  officeId: string;
  keyPath: string;
  flairUrl?: string;
  syncIntervalMs?: number;
  cursorPath?: string;
  flairAgentId?: string;    // which agent identity to use for local Flair auth
  flairKeyPath?: string;    // key for authenticating to local Flair
}

export interface OrgEventRecord {
  id: string;
  kind: string;
  authorId: string;
  summary: string;
  refId?: string;
  scope?: string;
  targetIds?: string[];
  createdAt: string;
}

export interface AgentStatus {
  agentId: string;
  name?: string;
  role?: string;
  status?: string;
  model?: string;
  lastSeen?: string;
}

export interface IngestPayload {
  officeId: string;
  events: OrgEventRecord[];
  agents: AgentStatus[];
  syncedAt: string;
}

export class ObservatorySync {
  private config: Required<ObservatorySyncConfig>;
  private privKey: ReturnType<typeof createPrivateKey> | null = null;
  private flairPrivKey: ReturnType<typeof createPrivateKey> | null = null;
  private running = false;

  constructor(config: ObservatorySyncConfig) {
    this.config = {
      flairUrl: process.env.FLAIR_URL ?? "http://127.0.0.1:9926",
      syncIntervalMs: Number(process.env.OBSERVATORY_INTERVAL_MS ?? 60_000),
      cursorPath: join(homedir(), ".tps", "cursors", `${config.officeId}-observatory.json`),
      flairAgentId: config.officeId,
      flairKeyPath: config.keyPath,
      ...config,
    };
  }

  private loadKey(keyPath: string): ReturnType<typeof createPrivateKey> {
    const raw = readFileSync(keyPath);
    try {
      return createPrivateKey(raw);
    } catch {
      const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
      return createPrivateKey({
        key: Buffer.concat([pkcs8Header, Buffer.from(raw)]),
        format: "der",
        type: "pkcs8",
      });
    }
  }

  private makeObsAuth(method: string, urlPath: string): string {
    if (!this.privKey) this.privKey = this.loadKey(this.config.keyPath);
    const ts = Date.now().toString();
    const nonce = Math.random().toString(36).slice(2, 10);
    const payload = `${this.config.officeId}:${ts}:${nonce}:${method}:${urlPath}`;
    const sig = sign(null, Buffer.from(payload), this.privKey).toString("base64");
    return `TPS-Ed25519 ${this.config.officeId}:${ts}:${nonce}:${sig}`;
  }

  private makeFlairAuth(method: string, urlPath: string): string {
    if (!this.flairPrivKey) this.flairPrivKey = this.loadKey(this.config.flairKeyPath);
    const agentId = this.config.flairAgentId;
    const ts = Date.now().toString();
    const nonce = Math.random().toString(36).slice(2, 10);
    const payload = `${agentId}:${ts}:${nonce}:${method}:${urlPath}`;
    const sig = sign(null, Buffer.from(payload), this.flairPrivKey).toString("base64");
    return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig}`;
  }

  private readCursor(): string {
    try {
      if (existsSync(this.config.cursorPath)) {
        const data = JSON.parse(readFileSync(this.config.cursorPath, "utf-8"));
        return data.since ?? new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/Z$/, ".000Z");
      }
    } catch { /* fall through */ }
    // Default: last hour
    return new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/Z$/, ".000Z");
  }

  private writeCursor(since: string): void {
    mkdirSync(dirname(this.config.cursorPath), { recursive: true });
    writeFileSync(this.config.cursorPath, JSON.stringify({ since, updatedAt: new Date().toISOString() }), "utf-8");
  }

  private async fetchEvents(since: string): Promise<OrgEventRecord[]> {
    const urlPath = `/OrgEventCatchup/${this.config.flairAgentId}?since=${since}`;
    const res = await fetch(this.config.flairUrl + urlPath, {
      headers: { Authorization: this.makeFlairAuth("GET", urlPath) },
    });
    if (!res.ok) {
      console.warn(`[observatory-sync] OrgEventCatchup returned ${res.status}`);
      return [];
    }
    return res.json() as Promise<OrgEventRecord[]>;
  }

  private async fetchAgents(): Promise<AgentStatus[]> {
    const urlPath = "/Agent/";
    const res = await fetch(this.config.flairUrl + urlPath, {
      headers: { Authorization: this.makeFlairAuth("GET", urlPath) },
    });
    if (!res.ok) {
      console.warn(`[observatory-sync] Agent list returned ${res.status}`);
      return [];
    }
    const raw = await res.json() as Array<Record<string, unknown>>;
    return raw.map((a) => ({
      agentId: String(a.id ?? a.agentId ?? ""),
      name: a.name ? String(a.name) : undefined,
      role: a.role ? String(a.role) : undefined,
      status: a.status ? String(a.status) : undefined,
      lastSeen: a.updatedAt ? String(a.updatedAt) : undefined,
    }));
  }

  private async ingest(payload: IngestPayload): Promise<boolean> {
    const urlPath = "/IngestEvents";
    try {
      const res = await fetch(this.config.observatoryUrl + urlPath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.makeObsAuth("POST", urlPath),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.warn(`[observatory-sync] IngestEvents returned ${res.status}: ${await res.text().catch(() => "")}`);
        return false;
      }
      return true;
    } catch (e) {
      const err = e as Error;
      console.warn(`[observatory-sync] IngestEvents failed: ${err.message}`);
      return false;
    }
  }

  async syncOnce(): Promise<{ events: number; agents: number; ok: boolean }> {
    const since = this.readCursor();
    const [events, agents] = await Promise.all([
      this.fetchEvents(since),
      this.fetchAgents(),
    ]);

    if (events.length === 0 && agents.length === 0) {
      return { events: 0, agents: 0, ok: true };
    }

    const payload: IngestPayload = {
      officeId: this.config.officeId,
      events,
      agents,
      syncedAt: new Date().toISOString(),
    };

    const ok = await this.ingest(payload);
    if (ok && events.length > 0) {
      // Advance cursor to last event's createdAt
      const latest = events[events.length - 1].createdAt;
      // Add 1ms to avoid re-fetching the last event
            const next = new Date(new Date(latest).getTime() + 1).toISOString();
      this.writeCursor(next);
    }

    return { events: events.length, agents: agents.length, ok };
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[observatory-sync] Starting — office=${this.config.officeId} interval=${this.config.syncIntervalMs}ms`);
    console.log(`[observatory-sync] Target: ${this.config.observatoryUrl}`);

    // Sync immediately, then on interval
    while (this.running) {
      try {
        const result = await this.syncOnce();
        if (result.events > 0 || result.agents > 0) {
          console.log(`[observatory-sync] Synced ${result.events} events, ${result.agents} agents → ${result.ok ? "ok" : "failed"}`);
        }
      } catch (e) {
        const err = e as Error;
        console.warn(`[observatory-sync] Sync error: ${err.message}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.syncIntervalMs));
    }
  }

  stop(): void {
    this.running = false;
  }
}

// Standalone entry point
if (import.meta.main) {
  const observatoryUrl = process.env.OBSERVATORY_URL;
  const officeId = process.env.OBSERVATORY_OFFICE_ID;
  const keyPath = process.env.OBSERVATORY_KEY_PATH ?? join(homedir(), ".tps", "identity", `${officeId}.key`);

  if (!observatoryUrl || !officeId) {
    console.error("Required: OBSERVATORY_URL and OBSERVATORY_OFFICE_ID env vars");
    process.exit(1);
  }

  const sync = new ObservatorySync({ observatoryUrl, officeId, keyPath });
  await sync.start();
}
