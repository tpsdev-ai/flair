import { Resource, databases } from "@harperfast/harper";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, join } from "node:path";

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

function rpcResult(id: string | number | null | undefined, result: any) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string, data?: any) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

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

function parseJsonSafe(value: unknown): any | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeA2AStatus(statusRaw: unknown): string | null {
  const status = cleanText(statusRaw).toLowerCase();
  if (!status) return null;
  if (status === "done" || status === "closed" || status === "complete" || status === "completed") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled") return "canceled";
  if (status === "working" || status === "in_progress" || status === "open" || status === "active" || status === "todo") {
    return "working";
  }
  return null;
}

function inferStatusFromText(textRaw: unknown): string | null {
  const text = cleanText(textRaw).toLowerCase();
  if (!text) return null;
  if (text.includes("completed") || text.includes("complete") || text.includes("done")) return "completed";
  if (text.includes("failed") || text.includes("error")) return "failed";
  if (text.includes("cancelled") || text.includes("canceled")) return "canceled";
  if (text.includes("working") || text.includes("started") || text.includes("in progress")) return "working";
  return null;
}

function taskIdFromEvent(event: any): string | null {
  const refId = cleanText(event?.refId);
  if (refId.startsWith("bd://")) {
    const taskId = cleanText(refId.slice("bd://".length));
    if (taskId) return taskId;
  }
  const detail = parseJsonSafe(event?.detail);
  const fromDetail = cleanText(detail?.taskId ?? detail?.id ?? detail?.task?.id);
  if (fromDetail) return fromDetail;
  return null;
}

function statusFromOrgEvent(event: any): string | null {
  const detail = parseJsonSafe(event?.detail);
  return (
    normalizeA2AStatus(detail?.status) ??
    normalizeA2AStatus(detail?.task?.status) ??
    normalizeA2AStatus(event?.status) ??
    normalizeA2AStatus(event?.kind) ??
    inferStatusFromText(event?.summary) ??
    null
  );
}

export class A2AAdapter extends Resource {
  async get() {
    const host = process.env.FLAIR_PUBLIC_URL || "http://localhost:9926";
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

    try {
      if (body.method === "message/stream") {
        const agentId = cleanText(params.agentId);
        if (!agentId) {
          return rpcError(id, -32602, "Invalid params: agentId is required");
        }

        const taskIdHint = cleanText(params.taskId) || null;
        const encoder = new TextEncoder();
        const startedAt = Date.now();
        const timeoutMs = 5 * 60 * 1000;
        let lastSeen = new Date(startedAt).toISOString();
        let closed = false;
        const seenEventIds = new Set<string>();
        const seenEventQueue: string[] = [];

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const writeEvent = (eventName: string, payload: any) => {
              if (closed) return;
              const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
              controller.enqueue(encoder.encode(frame));
            };

            const closeStream = () => {
              if (closed) return;
              closed = true;
              clearInterval(pollTimer);
              clearTimeout(timeoutTimer);
              controller.close();
            };

            const poll = async () => {
              if (closed) return;
              if (Date.now() - startedAt >= timeoutMs) { closeStream(); return; }

              const catchupUrl =
                `http://localhost:9926/OrgEventCatchup/${encodeURIComponent(agentId)}?since=${lastSeen}`;

              let events: any[] = [];
              try {
                const response = await fetch(catchupUrl);
                if (!response.ok) return;
                const data = await response.json();
                if (Array.isArray(data)) events = data;
                else if (Array.isArray(data?.events)) events = data.events;
              } catch { return; }

              for (const event of events) {
                const eventId = cleanText(event?.id) || `${cleanText(event?.createdAt)}:${cleanText(event?.summary)}`;
                if (eventId && seenEventIds.has(eventId)) continue;
                if (eventId) {
                  seenEventIds.add(eventId);
                  seenEventQueue.push(eventId);
                  if (seenEventQueue.length > 500) {
                    const removed = seenEventQueue.shift();
                    if (removed) seenEventIds.delete(removed);
                  }
                }
                const createdAt = cleanText(event?.createdAt);
                if (createdAt && createdAt > lastSeen) lastSeen = createdAt;

                const status = statusFromOrgEvent(event);
                if (!status) continue;

                writeEvent("task.status", rpcResult(id, {
                  type: "task",
                  task: { id: taskIdFromEvent(event) ?? taskIdHint, status },
                }));

                if (status === "completed" || status === "failed" || status === "canceled") {
                  closeStream(); return;
                }
              }
            };

            const pollTimer = setInterval(() => { void poll(); }, 2000);
            const timeoutTimer = setTimeout(() => { closeStream(); }, timeoutMs);
            void poll();
          },
          cancel() { closed = true; },
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

        const agent = await (databases as any).flair.Agent.get(agentId).catch(() => null);
        if (!agent) {
          return rpcError(id, -32004, "Agent not found", { agentId });
        }

        const summary = truncate(firstTextPart(message) || "A2A message received", 200);
        await publishOrgEvent({
          kind: "a2a.message",
          scope: agentId,
          summary,
          detail: JSON.stringify({ message }),
          targetIds: [agentId],
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
