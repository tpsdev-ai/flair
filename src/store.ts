import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Agent, DB, Integration } from "./types.js";

const DB_PATH = process.env.FLAIR_DB_PATH || join(process.env.HOME || homedir(), ".flair", "db.json");

function init(): DB {
  return { agents: [], integrations: [] };
}

function load(): DB {
  if (!existsSync(DB_PATH)) return init();
  return JSON.parse(readFileSync(DB_PATH, "utf-8")) as DB;
}

function save(db: DB): void {
  mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), { mode: 0o600 });
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
