import { Resource, databases } from "harper";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, join } from "node:path";
import { resolvePublicBaseUrl } from "./a2a-url.js";
import {
  cleanText,
  orgEventStream,
  rpcError,
  rpcResult,
  type CatchupPageReader,
  type JsonRpcId,
} from "./a2a-stream.js";
import { adminContext, agentContext } from "./in-process.js";
import { OrgEventCatchup } from "./OrgEventCatchup.js";

type JsonRpcRequest = {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
};

type BeadsIssue = {
  id: string;
  title?: string;
  description?: string;
  notes?: string;
  status?: string;
  assignee?: string;
  updated_at?: string;
  created_at?: string;
  [key: string]: any;
};

const BEADS_ROOT = join(process.env.HOME || "/root", "ops", ".beads");
const BEADS_ISSUES_DIR = join(BEADS_ROOT, "issues");
const BEADS_ISSUES_JSONL = join(BEADS_ROOT, "issues.jsonl");

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function firstTextPart(message: any): string {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  for (const part of parts) {
    const text = cleanText(part?.text);
    if (text) return text;
  }
  return "";
}

function stripQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSimpleYamlIssue(raw: string, fallbackId: string): BeadsIssue {
  const issue: BeadsIssue = { id: fallbackId };
  const lines = raw.split(/\r?\n/);
  let listKey: string | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const itemMatch = line.match(/^\s*-\s*(.+)\s*$/);
    if (itemMatch && listKey) {
      const current = issue[listKey];
      if (!Array.isArray(current)) issue[listKey] = [];
      issue[listKey].push(stripQuotes(itemMatch[1].trim()));
      continue;
    }

    if (/^\s/.test(line)) continue;

    const fieldMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)\s*$/);
    if (!fieldMatch) {
      listKey = null;
      continue;
    }

    const [, key, rawValue] = fieldMatch;
    if (rawValue === "") {
      issue[key] = issue[key] ?? "";
      listKey = key;
      continue;
    }

    if (rawValue === "[]" || rawValue === "[ ]") {
      issue[key] = [];
      listKey = null;
      continue;
    }

    if (rawValue === "|" || rawValue === ">") {
      issue[key] = "";
      listKey = null;
      continue;
    }

    issue[key] = stripQuotes(rawValue.trim());
    listKey = null;
  }

  if (!issue.id) issue.id = fallbackId;
  return issue;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readIssuesFromYamlDir(): Promise<BeadsIssue[]> {
  if (!(await pathExists(BEADS_ISSUES_DIR))) return [];

  const entries = await readdir(BEADS_ISSUES_DIR, { withFileTypes: true });
  const out: BeadsIssue[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext !== ".yaml" && ext !== ".yml") continue;

    const fullPath = join(BEADS_ISSUES_DIR, entry.name);
    const raw = await readFile(fullPath, "utf8");
    const fallbackId = basename(entry.name, ext);
    out.push(parseSimpleYamlIssue(raw, fallbackId));
  }
  return out;
}

async function readIssuesFromJsonl(): Promise<BeadsIssue[]> {
  if (!(await pathExists(BEADS_ISSUES_JSONL))) return [];
  const raw = await readFile(BEADS_ISSUES_JSONL, "utf8");
  const out: BeadsIssue[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.id) out.push(parsed);
    } catch {
      // Ignore malformed lines.
    }
  }
  return out;
}

async function readIssue(taskId: string): Promise<BeadsIssue | null> {
  const yamlPath = join(BEADS_ISSUES_DIR, `${taskId}.yaml`);
  const ymlPath = join(BEADS_ISSUES_DIR, `${taskId}.yml`);
  for (const candidate of [yamlPath, ymlPath]) {
    if (await pathExists(candidate)) {
      const raw = await readFile(candidate, "utf8");
      return parseSimpleYamlIssue(raw, taskId);
    }
  }

  const jsonlIssues = await readIssuesFromJsonl();
  return jsonlIssues.find((issue) => issue.id === taskId) ?? null;
}

function mapBeadsStatusToA2A(statusRaw: unknown): string {
  const status = cleanText(statusRaw).toLowerCase();
  if (status === "ready" || status === "in_progress" || status === "open" || status === "active" || status === "todo") {
    return "working";
  }
  if (status === "done" || status === "closed" || status === "complete" || status === "completed") {
    return "completed";
  }
  if (status === "blocked") {
    return "input-required";
  }
  if (status === "cancelled" || status === "canceled") {
    return "canceled";
  }
  return "working";
}

function taskView(issue: BeadsIssue): any {
  return {
    id: issue.id,
    title: issue.title ?? "",
    status: mapBeadsStatusToA2A(issue.status),
    assignee: issue.assignee ?? null,
    updatedAt: issue.updated_at ?? issue.created_at ?? null,
  };
}


async function taskHistory(taskId: string): Promise<any[]> {
  const history: any[] = [];
  const refId = `bd://${taskId}`;
  for await (const event of (databases as any).flair.OrgEvent.search()) {
    if (event?.refId !== refId) continue;
    const summary = cleanText(event.summary);
    if (!summary) continue;
    history.push({
      createdAt: event.createdAt ?? "",
      role: "agent",
      parts: [{ text: summary }],
    });
  }
  history.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return history.map(({ role, parts }) => ({ role, parts }));
}

function artifactsFromIssue(issue: BeadsIssue): any[] {
  const artifacts: any[] = [];
  const notes = cleanText(issue.notes);
  if (notes) {
    artifacts.push({ name: "notes", parts: [{ text: notes }] });
  }
  return artifacts;
}

async function publishOrgEvent(event: any): Promise<void> {
  await (databases as any).flair.OrgEvent.put({
    id: event.id ?? `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    authorId: event.authorId ?? "a2a",
    kind: event.kind,
    scope: event.scope ?? null,
    summary: event.summary,
    detail: event.detail ?? "",
    targetIds: event.targetIds ?? [],
    refId: event.refId ?? null,
    createdAt: event.createdAt ?? new Date().toISOString(),
  });
}

/**
 * The caller-match rule for message/send (params.agentId is the sender) and
 * message/stream (params.agentId is the agent whose events are streamed): a
 * non-admin caller may name only its own agent id; an admin caller may name
 * another agent. tasks/list does not use this rule (its params.agentId is an
 * assignee filter). Returns the JSON-RPC refusal, -32001 "Forbidden" with a
 * detail naming the method, or null when the caller may name `agentId`.
 */
function actAsRefusal(
  id: JsonRpcId,
  callerAgent: string | undefined,
  callerIsAdmin: boolean,
  agentId: string,
  action: "send" | "stream",
) {
  if (!callerIsAdmin && callerAgent !== agentId) {
    return rpcError(id, -32001, "Forbidden", {
      detail: `caller ${callerAgent ?? "(anon)"} cannot ${action} as ${agentId}`,
    });
  }
  return null;
}

/**
 * message/stream's reader: one page of `participantId`'s catch-up after the
 * stream's own cursor, read in process through OrgEventCatchup with the
 * requesting caller's identity. OrgEventCatchup applies its owner check to
 * that caller and returns the events targeted at `participantId` or carrying
 * no targets, not expired, after the cursor, in position order. Each read gets
 * a fresh context (and so its own transaction) carrying exactly the caller's
 * agent id and admin flag. The read passes an explicit `after` cursor, so it
 * never creates or moves the agent's durable catch-up watermark.
 */
function callerCatchupReader(participantId: string, callerAgent: string, callerIsAdmin: boolean): CatchupPageReader {
  return (after) => (OrgEventCatchup as any).get(
    { id: participantId, conditions: [{ attribute: "after", value: after }] },
    callerIsAdmin ? adminContext(callerAgent) : agentContext(callerAgent),
  );
}

export class A2AAdapter extends Resource {

  // A2A discovery surface — agent-card metadata (GET) is intentionally
  // public so other agents/clients can discover this Flair as a memory
  // peer. POST is JSON-RPC for actions (message/send writes OrgEvents,
  // tasks/list reads the instance's Beads task board, message/stream
  // streams the OrgEvents for params.agentId) and is auth-gated upstream by
  // auth-middleware's narrowed allow-list (GET /a2a passes through;
  // POST /a2a must carry TPS-Ed25519 or admin Basic). The post() handler
  // below additionally applies the caller-match rule to message/send and
  // message/stream (actAsRefusal): a non-admin caller may name only its own
  // agent id there; an admin caller may name another agent. message/send
  // routes a DIRECTED handoff to params.toAgentId (the recipient) by
  // setting the OrgEvent's targetIds = [toAgentId]; OrgEventCatchup filters
  // on that, so the recipient — not the sender — receives the message.
  // tasks/list is not caller-scoped: any authenticated caller can request
  // the unfiltered board, and its params.agentId only filters by assignee.
  allowRead() { return true; }
  allowCreate() { return true; }

  async get() {
    // Resolve the URL remote peers should use to reach this Flair. Prefer the
    // request Host header (how the caller actually reached us) over a
    // hardcoded port, so a default local install advertises the REAL HTTP
    // port (19926), not the dead legacy 9926 (flair#507).
    const ctx = (this as any).getContext?.() ?? {};
    const ctxRequest = ctx.request ?? ctx;
    const host = resolvePublicBaseUrl(ctxRequest);
    return new Response(JSON.stringify({
      name: "TPS Agent Team",
      description: "TPS — agent OS for humans and AI agents. Coordinates via Flair.",
      url: `${host}/a2a`,
      version: "0.1.0",
      capabilities: {
        streaming: true,
        pushNotifications: false,
      },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [
        {
          id: "task-management",
          name: "Task Management",
          description: "Create, list, and track tasks via Beads issue tracker",
        },
        {
          id: "agent-coordination",
          name: "Agent Coordination", 
          description: "Send messages to agents and coordinate work via OrgEvents",
        },
      ],
    }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  async post(content: any, _context?: any) {
    const body: JsonRpcRequest = content as JsonRpcRequest;

    if (!body || typeof body !== "object") {
      return rpcError(null, -32600, "Invalid Request");
    }
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return rpcError(body.id, -32600, "Invalid Request");
    }

    const id = body.id ?? null;
    const params = body.params ?? {};

    // Defense-in-depth: auth-middleware narrows the /a2a allow-list so
    // POSTs only reach here after TPS-Ed25519 or admin Basic succeeds,
    // which sets request.tpsAgent / tpsAgentIsAdmin. If middleware was
    // misconfigured or someone added a back-door allow-list entry, fail
    // closed here. Pattern matches WorkspaceState/Memory/etc.
    const ctx = (this as any).getContext?.() ?? _context ?? {};
    const ctxRequest = ctx.request ?? ctx;
    const callerAgent: string | undefined = ctxRequest?.tpsAgent;
    const callerIsAdmin: boolean = ctxRequest?.tpsAgentIsAdmin === true;
    if (!callerAgent && !callerIsAdmin) {
      return rpcError(id, -32001, "Unauthorized", {
        detail: "POST /a2a requires TPS-Ed25519 or admin Basic auth",
      });
    }

    try {
      if (body.method === "message/stream") {
        const agentId = cleanText(params.agentId);
        if (!agentId) {
          return rpcError(id, -32602, "Invalid params: agentId is required");
        }
        const refusal = actAsRefusal(id, callerAgent, callerIsAdmin, agentId, "stream");
        if (refusal) return refusal;
        // The reader needs the caller's agent id to build its context; an
        // admin-flagged request without one cannot be read as anyone.
        if (!callerAgent) {
          return rpcError(id, -32001, "Forbidden", { detail: `caller (anon) cannot stream as ${agentId}` });
        }

        const stream = orgEventStream({
          rpcId: id,
          readPage: callerCatchupReader(agentId, callerAgent, callerIsAdmin),
          taskId: cleanText(params.taskId) || null,
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }

      if (body.method === "message/send") {
        const agentId = cleanText(params.agentId);
        const message = params.message;
        if (!agentId || !message || typeof message !== "object") {
          return rpcError(id, -32602, "Invalid params: agentId and message are required");
        }

        // Sender must match params.agentId — you can only send AS yourself.
        // Admin agents may send as anyone (operational convenience).
        // Without this check, an authenticated agent could forge OrgEvents
        // attributed to any other agent — defeats the whole signed-envelopes
        // model that delegationChain enforces for TPS mail.
        // NOTE: agentId is the SENDER. The recipient is params.toAgentId.
        const refusal = actAsRefusal(id, callerAgent, callerIsAdmin, agentId, "send");
        if (refusal) return refusal;

        const sender = await (databases as any).flair.Agent.get(agentId).catch(() => null);
        if (!sender) {
          return rpcError(id, -32004, "Agent not found", { agentId });
        }

        // Directed handoff: params.toAgentId (the recipient) controls
        // OrgEvent.targetIds, which is what OrgEventCatchup filters on
        // (`targets.includes(participantId)`). The recipient must exist.
        // Back-compat: if toAgentId is omitted, fall back to the legacy
        // self-scoped broadcast (targetIds = [sender]) so existing callers
        // that only set agentId keep working. The no-spoof guard above is
        // unchanged — toAgentId only affects WHO receives the message, never
        // who it is sent AS, so a sender can hand off to a peer without being
        // able to impersonate anyone.
        const toAgentId = cleanText(params.toAgentId);
        let targetIds: string[];
        if (toAgentId) {
          const recipient = await (databases as any).flair.Agent.get(toAgentId).catch(() => null);
          if (!recipient) {
            return rpcError(id, -32004, "Recipient agent not found", { toAgentId });
          }
          targetIds = [toAgentId];
        } else {
          targetIds = [agentId];
        }

        const summary = truncate(firstTextPart(message) || "A2A message received", 200);
        await publishOrgEvent({
          authorId: agentId,
          kind: "a2a.message",
          scope: agentId,
          summary,
          detail: JSON.stringify({ message, toAgentId: toAgentId || null }),
          targetIds,
        });

        return rpcResult(id, {
          type: "message",
          message: {
            role: "agent",
            parts: [{ text: "Message received. Task created." }],
          },
        });
      }

      if (body.method === "tasks/get") {
        const taskId = cleanText(params.taskId);
        if (!taskId) return rpcError(id, -32602, "Invalid params: taskId is required");

        const issue = await readIssue(taskId);
        if (!issue) return rpcError(id, -32004, "Task not found", { taskId });

        const history = await taskHistory(taskId);
        return rpcResult(id, {
          type: "task",
          task: {
            ...taskView(issue),
            artifacts: artifactsFromIssue(issue),
            history,
          },
        });
      }

      if (body.method === "tasks/list") {
        // One source, never both: the `.yaml`/`.yml` issue files under
        // ~/ops/.beads/issues/ when at least one exists, otherwise
        // ~/ops/.beads/issues.jsonl. params.agentId filters by assignee and
        // params.status by the mapped A2A status; neither is matched to the
        // caller.
        const yamlIssues = await readIssuesFromYamlDir();
        const issues = yamlIssues.length > 0 ? yamlIssues : await readIssuesFromJsonl();

        const agentIdFilter = cleanText(params.agentId).toLowerCase();
        const statusFilter = cleanText(params.status).toLowerCase();

        const tasks = issues
          .filter((issue) => {
            if (agentIdFilter) {
              const assignee = cleanText(issue.assignee).toLowerCase();
              if (assignee !== agentIdFilter) return false;
            }
            if (statusFilter) {
              const mapped = mapBeadsStatusToA2A(issue.status).toLowerCase();
              if (mapped !== statusFilter) return false;
            }
            return true;
          })
          .map((issue) => taskView(issue))
          .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

        return rpcResult(id, { type: "tasks", tasks });
      }

      return rpcError(id, -32601, "Method not found");
    } catch (error: any) {
      return rpcError(id, -32000, "Server error", { detail: error?.message ?? String(error) });
    }
  }
}

// Expose exact lowercase endpoint required by A2A clients: POST /a2a
export class a2a extends A2AAdapter {}

/**
 * Harper's REST layer dispatches a request whose `Accept` header is exactly
 * `text/event-stream` as CONNECT, not POST (#2717), so a spec-shaped A2A
 * client's `message/stream` POST reaches the resource's static connect instead
 * of the post dispatch. A POST that carries a JSON-RPC request is handed to the
 * same static post dispatch, which applies the same authentication, caller-match
 * and params checks and returns the same SSE response as without the header.
 * Any other request (another method, or a POST body that is not a JSON-RPC
 * request) keeps the resource's default connect handling.
 *
 * Assigned after the class because Harper's typings describe the base static
 * verb dispatch, not a subclass override.
 */
(A2AAdapter as any).connect = async function connect(this: any, target: any, _data: any, request?: any) {
  let body: any;
  try {
    body = await request?.data;
  } catch {
    body = undefined;
  }
  if (
    request?.method === "POST" &&
    body && typeof body === "object" && !Array.isArray(body) &&
    typeof body.jsonrpc === "string" && typeof body.method === "string"
  ) {
    return this.post(target, body, request);
  }
  return (Resource as any).connect.call(this, target, _data, request);
};
