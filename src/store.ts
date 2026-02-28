import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Agent, DB, Integration, Memory, Soul, Durability } from "./types.js";

function dbPath(): string {
  return process.env.FLAIR_DB_PATH || join(process.env.HOME || homedir(), ".flair", "db.json");
}
const EPHEMERAL_TTL_HOURS = Number(process.env.FLAIR_EPHEMERAL_TTL_HOURS || 24);

function init(): DB {
  return { agents: [], integrations: [], memories: [], souls: [] };
}

function load(): DB {
  const path = dbPath();
  if (!existsSync(path)) return init();
  const db = JSON.parse(readFileSync(path, "utf-8")) as DB;
  db.memories ||= [];
  db.souls ||= [];
  pruneExpired(db);
  return db;
}

function save(db: DB): void {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(db, null, 2), { mode: 0o600 });
}

function pruneExpired(db: DB): void {
  const now = Date.now();
  db.memories = db.memories.filter((m) => !m.expiresAt || Date.parse(m.expiresAt) > now);
}

function makeExpiry(durability: Durability, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (durability !== "ephemeral") return undefined;
  return new Date(Date.now() + EPHEMERAL_TTL_HOURS * 60 * 60 * 1000).toISOString();
}

export function listAgents(): Agent[] { return load().agents; }
export function getAgent(id: string): Agent | undefined { return load().agents.find((a) => a.id === id); }

export function upsertAgent(agent: Agent): Agent {
  const db = load();
  const i = db.agents.findIndex((a) => a.id === agent.id);
  if (i >= 0) db.agents[i] = { ...db.agents[i], ...agent, updatedAt: new Date().toISOString() };
  else db.agents.push(agent);
  save(db);
  return getAgent(agent.id)!;
}

export function listIntegrations(agentId?: string): Integration[] {
  const all = load().integrations;
  return agentId ? all.filter((i) => i.agentId === agentId) : all;
}

export function addIntegration(integration: Integration): Integration {
  const db = load();
  const i = db.integrations.findIndex((x) => x.id === integration.id);
  if (i >= 0) db.integrations[i] = { ...db.integrations[i], ...integration, updatedAt: new Date().toISOString() };
  else db.integrations.push(integration);
  save(db);
  return db.integrations.find((x) => x.id === integration.id)!;
}

export function createMemory(input: Omit<Memory, "id" | "createdAt" | "updatedAt" | "expiresAt"> & { expiresAt?: string }): Memory {
  const db = load();
  const now = new Date().toISOString();
  const durability = (input.durability || "standard") as Durability;
  const m: Memory = {
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    durability,
    expiresAt: makeExpiry(durability, input.expiresAt),
  };
  db.memories.push(m);
  save(db);
  return m;
}

export function getMemory(id: string): Memory | undefined {
  return load().memories.find((m) => m.id === id);
}

export function listMemories(params: { agentId?: string; tag?: string } = {}): Memory[] {
  const all = load().memories;
  return all.filter((m) => (!params.agentId || m.agentId === params.agentId) && (!params.tag || (m.tags || []).includes(params.tag)));
}

export function searchMemories(params: { agentId?: string; q?: string; tag?: string }): Memory[] {
  const q = (params.q || "").toLowerCase();
  return listMemories({ agentId: params.agentId, tag: params.tag }).filter((m) => !q || m.content.toLowerCase().includes(q));
}

export function deleteMemory(id: string): { ok: true } {
  const db = load();
  const row = db.memories.find((m) => m.id === id);
  if (!row) throw new Error("not_found");
  if (row.durability === "permanent") throw new Error("permanent_memory_cannot_be_deleted");
  db.memories = db.memories.filter((m) => m.id !== id);
  save(db);
  return { ok: true };
}

export function upsertSoul(input: Omit<Soul, "createdAt" | "updatedAt" | "id"> & { id?: string }): Soul {
  const db = load();
  const now = new Date().toISOString();
  const id = input.id || `${input.agentId}:${input.key}`;
  const durability: Durability = input.durability || "permanent";
  const i = db.souls.findIndex((s) => s.id === id);
  if (i >= 0) {
    db.souls[i] = { ...db.souls[i], ...input, id, durability, updatedAt: now };
  } else {
    db.souls.push({ ...input, id, durability, createdAt: now, updatedAt: now });
  }
  save(db);
  return db.souls.find((s) => s.id === id)!;
}

export function getSoul(id: string): Soul | undefined {
  return load().souls.find((s) => s.id === id);
}

export function listSouls(agentId?: string): Soul[] {
  const all = load().souls;
  return agentId ? all.filter((s) => s.agentId === agentId) : all;
}
