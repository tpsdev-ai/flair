/**
 * a2a-stream.ts — the A2A `message/stream` event stream and the JSON-RPC
 * envelope helpers the A2A adapter shares with it.
 *
 * Harper-free on purpose: the stream reads through a `readPage` function the
 * caller supplies, so its lifecycle (polling, cursor, cancel, error frames) is
 * pinned by test/unit/a2a-stream.test.ts without a store. resources/A2AAdapter.ts
 * supplies a reader that runs OrgEventCatchup in process with the caller's own
 * context (see callerCatchupReader there).
 *
 * Wire format (Server-Sent Events):
 *   - an opening `: stream open` comment, so the response headers reach the
 *     client before the first event;
 *   - `event: org.event`, `data:` a JSON-RPC result `{ type: "event", event }`
 *     for every OrgEvent the reader returns, in catch-up position order;
 *   - `event: task.status`, `data:` a JSON-RPC result `{ type: "task", task }`
 *     after an `org.event` frame whose event carries a task status;
 *   - `event: error`, `data:` a JSON-RPC error, sent once when a read is
 *     refused or fails; the stream then ends.
 *
 * The stream ends when the client disconnects or cancels (the pending poll is
 * cleared and no further read starts), after `maxMs`, after a terminal status
 * for the task the request named, or after an error frame.
 */

export type JsonRpcId = string | number | null | undefined;

export function rpcResult(id: JsonRpcId, result: any) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function rpcError(id: JsonRpcId, code: number, message: string, data?: any) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function cleanText(value: unknown): string {
  return String(value ?? "").trim();
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

export function taskIdFromEvent(event: any): string | null {
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

export function statusFromOrgEvent(event: any): string | null {
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

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

/** One catch-up page: the events after the cursor, the next cursor, and whether more remain. */
export interface CatchupPage {
  events: any[];
  nextAfter: string;
  hasMore: boolean;
}

/**
 * Reads the page of catch-up events strictly after `after`. A `Response` is a
 * refusal from the catch-up resource (its 400/403 answers); it ends the stream
 * with an error frame.
 */
export type CatchupPageReader = (after: string) => Promise<CatchupPage | Response>;

export interface OrgEventStreamOptions {
  /** The JSON-RPC request id every frame answers. */
  rpcId: JsonRpcId;
  readPage: CatchupPageReader;
  /** Exclusive starting cursor: events at or before it are not delivered. */
  startAfter: string;
  /** `params.taskId`: a terminal status for this task ends the stream. */
  taskId?: string | null;
  pollMs?: number;
  maxMs?: number;
}

export const A2A_STREAM_POLL_MS = 2000;
export const A2A_STREAM_MAX_MS = 5 * 60 * 1000;

function isResponseLike(value: unknown): value is Response {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as any).status === "number" &&
    typeof (value as any).json === "function"
  );
}

async function refusalError(rpcId: JsonRpcId, response: Response) {
  let detail: unknown = null;
  try {
    const body = await response.json();
    detail = body?.error ?? body ?? null;
  } catch {
    detail = null;
  }
  if (response.status === 403) return rpcError(rpcId, -32001, "Forbidden", { detail });
  if (response.status === 401) return rpcError(rpcId, -32001, "Unauthorized", { detail });
  if (response.status === 400) return rpcError(rpcId, -32602, "Invalid params", { detail });
  return rpcError(rpcId, -32000, "Server error", { status: response.status, detail });
}

/**
 * The `message/stream` body. Polls `readPage` from `startAfter`, draining every
 * page (`hasMore`) on each poll, and schedules the next poll only after the
 * current one finishes, so two reads never overlap.
 */
export function orgEventStream(opts: OrgEventStreamOptions): ReadableStream<Uint8Array> {
  const pollMs = opts.pollMs ?? A2A_STREAM_POLL_MS;
  const maxMs = opts.maxMs ?? A2A_STREAM_MAX_MS;
  const taskId = cleanText(opts.taskId) || null;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let after = opts.startAfter;

  // Stop scheduling: no poll starts after this. A read already in flight
  // finishes, sees `closed`, and writes nothing.
  const stop = () => {
    closed = true;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    if (maxTimer !== undefined) clearTimeout(maxTimer);
    pollTimer = undefined;
    maxTimer = undefined;
  };

  const end = () => {
    if (closed) return;
    stop();
    try { controller?.close(); } catch { /* already closed or cancelled */ }
  };

  const write = (chunk: string) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      // The consumer is gone; nothing further can be delivered.
      stop();
    }
  };

  const frame = (name: string, payload: unknown) => write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);

  const fail = (payload: unknown) => {
    frame("error", payload);
    end();
  };

  const deliver = (event: any): boolean => {
    frame("org.event", rpcResult(opts.rpcId, { type: "event", event }));
    const status = statusFromOrgEvent(event);
    if (!status) return false;
    const eventTaskId = taskIdFromEvent(event);
    frame("task.status", rpcResult(opts.rpcId, {
      type: "task",
      task: { id: eventTaskId ?? taskId, status },
    }));
    return taskId !== null && eventTaskId === taskId && TERMINAL_STATUSES.has(status);
  };

  const poll = async () => {
    pollTimer = undefined;
    if (closed) return;
    try {
      for (;;) {
        const page = await opts.readPage(after);
        if (closed) return;
        if (isResponseLike(page)) {
          const error = await refusalError(opts.rpcId, page);
          if (!closed) fail(error);
          return;
        }
        if (!page || typeof page !== "object" || !Array.isArray(page.events)) {
          fail(rpcError(opts.rpcId, -32000, "Server error", { detail: "the catch-up read returned no page" }));
          return;
        }
        for (const event of page.events) {
          if (deliver(event)) { end(); return; }
          if (closed) return;
        }
        if (typeof page.nextAfter === "string" && page.nextAfter) after = page.nextAfter;
        if (!page.hasMore || page.events.length === 0) break;
      }
    } catch (error: any) {
      if (!closed) fail(rpcError(opts.rpcId, -32000, "Server error", { detail: error?.message ?? String(error) }));
      return;
    }
    if (!closed) pollTimer = setTimeout(() => { void poll(); }, pollMs);
  };

  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      write(": stream open\n\n");
      maxTimer = setTimeout(end, maxMs);
      pollTimer = setTimeout(() => { void poll(); }, 0);
    },
    cancel() {
      stop();
    },
  });
}
