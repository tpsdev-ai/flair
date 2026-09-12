/**
 * Cursor Cloud Agents API v1 — create with a client-supplied agentId.
 *
 * POST https://api.cursor.com/v1/agents
 * Auth: Basic (api key as username, empty password) or Bearer.
 *
 * Idempotency: the same `agentId` (`bc-<uuid>`) returns 409 on replay rather
 * than launching a second agent. That is the single-launch guarantee.
 * See https://cursor.com/docs/cloud-agent/api/endpoints
 */

import type { DirectedDispatch } from "./dispatch.js";
import { buildWakeName, buildWakePrompt } from "./dispatch.js";

export interface CursorLaunchConfig {
  apiBase: string;
  apiKey: string;
  repoUrl?: string;
  startingRef?: string;
  envName?: string;
  envType?: "cloud" | "pool" | "machine";
  autoCreatePr?: boolean;
}

export interface LaunchInput {
  cursorAgentId: string;
  dispatch: DirectedDispatch;
  crewAgentId: string;
}

export type LaunchOutcome = "created" | "already" | "dry-run";

export interface LaunchResult {
  outcome: LaunchOutcome;
  cursorAgentId: string;
  url?: string;
}

export interface CursorAgentClient {
  create: (input: LaunchInput) => Promise<LaunchResult>;
}

export function resolveRepo(dispatch: DirectedDispatch, config: CursorLaunchConfig): {
  repoUrl?: string;
  prUrl?: string;
  startingRef?: string;
} {
  const repoUrl = config.repoUrl ?? dispatch.repoUrl ?? undefined;
  const prUrl = dispatch.prUrl ?? undefined;
  return { repoUrl, prUrl, startingRef: config.startingRef };
}

export function buildCreateBody(input: LaunchInput, config: CursorLaunchConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    prompt: { text: buildWakePrompt(input.dispatch, input.crewAgentId) },
    name: buildWakeName(input.dispatch),
    agentId: input.cursorAgentId,
  };
  if (config.envName) {
    body.env = { type: config.envType ?? "cloud", name: config.envName };
  } else {
    const { repoUrl, prUrl, startingRef } = resolveRepo(input.dispatch, config);
    if (repoUrl) {
      const repo: Record<string, unknown> = { url: repoUrl };
      if (startingRef) repo.startingRef = startingRef;
      if (prUrl) repo.prUrl = prUrl;
      body.repos = [repo];
    }
  }
  if (config.autoCreatePr === true) body.autoCreatePR = true;
  return body;
}

export function isAgentIdConflict(status: number, body: unknown): boolean {
  if (status !== 409) return false;
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  // Fail closed: only the documented idempotent-create conflict. An empty
  // body, `{}`, or `{ error: {} }` is an unknown 409 — treating it as
  // "already" would ack the watermark and drop the dispatch.
  return /agent_id_conflict|already exists/i.test(text);
}

export function createCursorAgentClient(
  config: CursorLaunchConfig,
  fetchImpl: typeof fetch = fetch,
): CursorAgentClient {
  const base = config.apiBase.replace(/\/$/, "");
  return {
    async create(input: LaunchInput): Promise<LaunchResult> {
      const response = await fetchImpl(`${base}/v1/agents`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.apiKey}:`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildCreateBody(input, config)),
      });
      const raw = await response.text();
      let parsed: Record<string, unknown> = {};
      if (raw) {
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          parsed = { error: raw };
        }
      }
      if (response.status === 201 || response.status === 200) {
        const agent = (parsed.agent as Record<string, unknown> | undefined) ?? parsed;
        const url = typeof agent.url === "string" ? agent.url : undefined;
        const id = typeof agent.id === "string" ? agent.id : input.cursorAgentId;
        return { outcome: "created", cursorAgentId: id, url };
      }
      if (isAgentIdConflict(response.status, parsed.error ?? parsed ?? raw)) {
        return { outcome: "already", cursorAgentId: input.cursorAgentId };
      }
      const message =
        (typeof parsed.error === "string" && parsed.error) ||
        (typeof parsed.message === "string" && parsed.message) ||
        raw ||
        `HTTP ${response.status}`;
      throw new Error(`Cursor create agent failed (${response.status}): ${message}`);
    },
  };
}

export function dryRunCursorClient(): CursorAgentClient {
  return {
    async create(input: LaunchInput): Promise<LaunchResult> {
      return { outcome: "dry-run", cursorAgentId: input.cursorAgentId };
    },
  };
}
