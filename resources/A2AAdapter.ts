import { Resource, tables } from "harperdb";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";

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

const BEADS_ROOT = join(homedir(), "ops", ".beads");
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

async function cancelIssue(taskId: string): Promise<BeadsIssue | null> {
  const yamlPath = join(BEADS_ISSUES_DIR, `${taskId}.yaml`);
  const ymlPath = join(BEADS_ISSUES_DIR, `${taskId}.yml`);
  const nowIso = new Date().toISOString();

  for (const candidate of [yamlPath, ymlPath]) {
    if (!(await pathExists(candidate))) continue;
    const original = await readFile(candidate, "utf8");
    const hasStatus = /^status:\s*.+$/m.test(original);
    const updated = hasStatus
      ? original.replace(/^status:\s*.+$/m, "status: cancelled")
      : `${original.trimEnd()}\nstatus: cancelled\n`;
    await writeFile(candidate, updated, "utf8");
    const issue = parseSimpleYamlIssue(updated, taskId);
    issue.status = "cancelled";
    issue.updated_at = nowIso;
    return issue;
  }

  const issues = await readIssuesFromJsonl();
  const idx = issues.findIndex((issue) => issue.id === taskId);
  if (idx === -1) return null;

  issues[idx] = {
    ...issues[idx],
    status: "cancelled",
    updated_at: nowIso,
    closed_at: nowIso,
    close_reason: issues[idx].close_reason ?? "Cancelled via A2A",
  };

  const serialized = `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`;
  await writeFile(BEADS_ISSUES_JSONL, serialized, "utf8");
  return issues[idx];
}

async function taskHistory(taskId: string): Promise<any[]> {
  const history: any[] = [];
  const refId = `bd://${taskId}`;
  for await (const event of (tables as any).OrgEvent.search()) {
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
  await (tables as any).OrgEvent.put({
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

export class A2AAdapter extends Resource {
  async post(targetOrData: any, maybeData?: any) {
    const body: JsonRpcRequest = (maybeData ?? targetOrData) as JsonRpcRequest;

    if (!body || typeof body !== "object") {
      return rpcError(null, -32600, "Invalid Request");
    }
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return rpcError(body.id, -32600, "Invalid Request");
    }

    const id = body.id ?? null;
    const params = body.params ?? {};

    try {
      if (body.method === "message/send") {
        const agentId = cleanText(params.agentId);
        const message = params.message;
        if (!agentId || !message || typeof message !== "object") {
          return rpcError(id, -32602, "Invalid params: agentId and message are required");
        }

        const agent = await (tables as any).Agent.get(agentId).catch(() => null);
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

      if (body.method === "tasks/cancel") {
        const taskId = cleanText(params.taskId);
        if (!taskId) return rpcError(id, -32602, "Invalid params: taskId is required");

        const issue = await cancelIssue(taskId);
        if (!issue) return rpcError(id, -32004, "Task not found", { taskId });

        await publishOrgEvent({
          kind: "task.cancelled",
          scope: issue.assignee ?? null,
          summary: `Task ${taskId} cancelled`,
          detail: "Cancelled via A2A tasks/cancel",
          targetIds: issue.assignee ? [issue.assignee] : [],
          refId: `bd://${taskId}`,
        });

        return rpcResult(id, {
          type: "task",
          task: {
            ...taskView({ ...issue, status: "cancelled" }),
            history: [{ role: "agent", parts: [{ text: `Task ${taskId} cancelled.` }] }],
          },
        });
      }

      return rpcError(id, -32601, "Method not found");
    } catch (error: any) {
      return rpcError(id, -32000, "Server error", { detail: error?.message ?? String(error) });
    }
  }
}

// Expose exact lowercase endpoint required by A2A clients: POST /a2a
export class a2a extends A2AAdapter {}
