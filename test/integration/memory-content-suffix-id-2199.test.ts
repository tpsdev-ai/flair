/**
 * memory-content-suffix-id-2199.test.ts — flair#2199, real Harper.
 *
 * Harper reads `.content` after the first dot in a by-id Memory path as a
 * property selector: `/Memory/x.content` addresses record `x`.
 *
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(harper: HarperInstance): void {
  const http = new URL(harper.httpURL);
  const ops = new URL(harper.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !harper.process?.pid || !harper.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${harper.httpURL} / ${harper.opsURL} is not an instance this test started`);
  }
}
async function authSend(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}
async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status, `seed agent returned ${res.status}`).toBe(200);
}
async function insertRow(harper: HarperInstance, id: string, content: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Memory",
    records: [{ id, agentId: author.id, content, contentHash: id, visibility: "shared", archived: false, instanceToken: randomUUID(), createdAt: "2026-01-01T00:00:00.000Z" }],
  });
  expect(res.status, `raw insert of ${id} returned ${res.status}`).toBe(200);
}

let harper: HarperInstance;
const author = mkAgent("mcs-author");
const reader = mkAgent("mcs-reader");

const BASE = "mcs-base";
const DEL_BASE = "mcs-del-base";
const DEL_OTHER_BASE = "mcs-del-other-base";
const SLASH = "mcs-slash";
const SLASH_BASE = `${SLASH}/base`;
// flair#2307: the literal id a twice-encoded slash (`%252F`) decodes to.
const DEEP = "mcs-deep";
const DEEP_BASE = `${DEEP}%2Fbase`;
// flair#2307: a segment that is not valid percent-encoding (the escapes are
// well formed but are not UTF-8), ending in a literal `.content`.
const MALFORMED = "mcs-bad%E0%A4";

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
  await seedAgent(harper, author);
  await seedAgent(harper, reader);
  await insertRow(harper, BASE, "BASE BODY");
  await insertRow(harper, "mcs-put-url-existing", "PUT BASE BODY");
  await insertRow(harper, "mcs-patch-url-existing", "PATCH BASE BODY");
  await insertRow(harper, DEL_BASE, "DEL BASE BODY");
  await insertRow(harper, DEL_OTHER_BASE, "DEL OTHER BASE BODY");
  await insertRow(harper, SLASH_BASE, "SLASH BASE BODY");
  await insertRow(harper, DEEP_BASE, "DEEP BASE BODY");
}, 240_000);

afterAll(async () => { if (harper) await stopHarper(harper); });

describe("flair#2199 — the ordinary `.content` selector still works", () => {
  it("a non-admin GET of `/Memory/<id>.content` returns the row named by `<id>`", async () => {
    const res = await authSend(harper, reader, "GET", `/Memory/${BASE}.content`);
    const body = await res.json();
    console.log("selector body:", JSON.stringify(body), "status:", res.status);
    expect(res.status).toBe(200);
    expect(body.id).toBe(BASE);
  }, 30_000);

  it("a non-admin GET of an encoded-slash id with no suffix returns that exact row", async () => {
    const res = await authSend(harper, reader, "GET", `/Memory/${SLASH}%2Fbase`);
    const body = await res.json();
    console.log("slash exact body:", JSON.stringify(body), "status:", res.status);
    expect(res.status).toBe(200);
    expect(body.id).toBe(SLASH_BASE);
  }, 30_000);
});

describe("flair#2199 — an encoded `/` before a declared suffix is refused, never rewritten", () => {
  it("a non-admin GET of `/Memory/<a>%2F<b>.content` is refused with `ambiguous_memory_id`", async () => {
    const res = await authSend(harper, reader, "GET", `/Memory/${SLASH}%2Fbase.content`);
    const body = await res.json();
    console.log("slash suffix body:", JSON.stringify(body), "status:", res.status);
    expect(res.status).toBe(400);
    expect(body.error).toBe("ambiguous_memory_id");
    expect(body.id).toBeUndefined(); // assertion: no record was served
  }, 30_000);

  it("a non-admin HEAD of `/Memory/<a>%2F<b>.content` returns 400 with no body", async () => {
    const res = await authSend(harper, reader, "HEAD", `/Memory/${SLASH}%2Fbase.content`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
  }, 30_000);

  it("refuses the lowercase `%2f` spelling too", async () => {
    const res = await authSend(harper, reader, "GET", `/Memory/${SLASH}%2fbase.content`);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("ambiguous_memory_id");
  }, 30_000);
});

describe("flair#2199 — Memory resource writes and feed POST refuse an id ending in `.content`", () => {
  const cases: Array<{ name: string; method: string; path: string; body: unknown }> = [
    { name: "collection POST /Memory", method: "POST", path: "/Memory", body: { id: "mcs-post.content", agentId: author.id, content: "x" } },
    { name: "PUT to a `.content` address", method: "PUT", path: "/Memory/mcs-put.content", body: { id: "mcs-put.content", agentId: author.id, content: "x" } },
    { name: "PATCH to a `.content` address", method: "PATCH", path: "/Memory/mcs-patch.content", body: { id: "mcs-patch.content", agentId: author.id, content: "x" } },
    { name: "PUT with an encoded-slash `.content` id", method: "PUT", path: "/Memory/mcs-s%2Fput.content", body: { id: "mcs-s/put.content", agentId: author.id, content: "x" } },
    { name: "feed POST /FeedMemories", method: "POST", path: "/FeedMemories", body: { id: "mcs-feed.content", agentId: author.id, content: "x" } },
  ];

  for (const c of cases) {
    it(`${c.name} → 400 memory_id_content_suffix`, async () => {
      const res = await authSend(harper, author, c.method, c.path, c.body);
      const body = await res.json();
      console.log(`${c.name}:`, res.status, JSON.stringify(body).slice(0, 160));
      expect(res.status).toBe(400);
      expect(body.error).toBe("memory_id_content_suffix");
    }, 30_000);
  }

  for (const method of ["PUT", "PATCH"]) {
    for (const state of ["existing", "missing"]) {
      it(`${method} with a suffix only in the URL and a ${state} base row → 400 memory_id_content_suffix without writing rows`, async () => {
        const id = `mcs-${method.toLowerCase()}-url-${state}`;
        // Harper 5.2's hash-search validator requires `get_attributes`
        // (dataLayer/harperBridge/ResourceBridge searchByHash → searchValidator
        // 'hashes'); without it the op answers 500 "'get_attributes' is required".
        const readRows = async () => {
          const res = await adminOp(harper, {
            operation: "search_by_hash", database: "flair", table: "Memory",
            hash_values: [id, `${id}.content`], get_attributes: ["*"],
          });
          const text = await res.text();
          expect(res.status, `search_by_hash returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
          return JSON.parse(text);
        };
        const before = await readRows();
        expect(before.length).toBe(state === "existing" ? 1 : 0);
        const res = await authSend(harper, author, method, `/Memory/${id}.content`, {
          id, agentId: author.id, content: "CHANGED BODY",
        });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("memory_id_content_suffix");
        expect(await readRows()).toEqual(before);
      }, 30_000);
    }
  }

  it("DELETE of a `.content` address → 400 memory_id_content_suffix and the base record is not deleted", async () => {
    const before = await authSend(harper, author, "GET", `/Memory/${DEL_BASE}`);
    expect(before.status).toBe(200);
    expect((await before.json()).agentId).toBe(author.id);
    const res = await authSend(harper, author, "DELETE", `/Memory/${DEL_BASE}.content`);
    const body = await res.json();
    console.log("DELETE .content:", res.status, JSON.stringify(body).slice(0, 160));
    expect(res.status).toBe(400);
    expect(body.error).toBe("memory_id_content_suffix");
    const after = await authSend(harper, author, "GET", `/Memory/${DEL_BASE}`);
    expect(after.status).toBe(200);
    expect((await after.json()).id).toBe(DEL_BASE);
  }, 30_000);

  it("non-owner DELETE of a `.content` address → 400 memory_id_content_suffix and the base record is not deleted", async () => {
    const res = await authSend(harper, reader, "DELETE", `/Memory/${DEL_OTHER_BASE}.content`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("memory_id_content_suffix");
    const after = await authSend(harper, author, "GET", `/Memory/${DEL_OTHER_BASE}`);
    expect(after.status).toBe(200);
    const row = await after.json();
    expect(row.id).toBe(DEL_OTHER_BASE);
    expect(row.agentId).toBe(author.id);
  }, 30_000);

  it("a POST with an id that does not end in `.content` still succeeds (control)", async () => {
    const res = await authSend(harper, author, "POST", "/Memory", { id: "mcs-ok", agentId: author.id, content: "ok" });
    console.log("control POST:", res.status, (await res.text()).slice(0, 120));
    expect([200, 201]).toContain(res.status);
  }, 30_000);
});

describe("flair#2307 — a malformed `.content` segment and a twice-encoded slash, through real Harper", () => {
  const readRows = async (ids: string[]) => {
    const res = await adminOp(harper, {
      operation: "search_by_hash", database: "flair", table: "Memory", hash_values: ids, get_attributes: ["*"],
    });
    const text = await res.text();
    expect(res.status, `search_by_hash returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    return JSON.parse(text);
  };

  it("a non-admin GET of a malformed segment ending in `.content` → 400 memory_id_content_suffix, no row served", async () => {
    const res = await authSend(harper, reader, "GET", `/Memory/${MALFORMED}.content`);
    const body = await res.json();
    expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(400);
    expect(body.error).toBe("memory_id_content_suffix");
    expect(body.id).toBeUndefined(); // assertion: no record was served
    expect(body.content).toBeUndefined();
  }, 30_000);

  it("a non-admin HEAD of a malformed segment ending in `.content` → 400", async () => {
    const res = await authSend(harper, reader, "HEAD", `/Memory/${MALFORMED}.content`);
    expect(res.status).toBe(400);
  }, 30_000);

  for (const method of ["PUT", "DELETE"]) {
    it(`a ${method} to a malformed segment ending in \`.content\` → 400 memory_id_content_suffix, no row changed`, async () => {
      const ids = [BASE, "mcs-bad", MALFORMED, `${MALFORMED}.content`];
      const before = await readRows(ids);
      const res = await authSend(harper, author, method, `/Memory/${MALFORMED}.content`,
        method === "PUT" ? { agentId: author.id, content: "CHANGED BODY" } : undefined);
      const body = await res.json();
      expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(400);
      expect(body.error).toBe("memory_id_content_suffix");
      expect(await readRows(ids)).toEqual(before);
    }, 30_000);
  }

  it("CONTROL: a non-admin GET of the twice-encoded slash with no suffix returns that exact row", async () => {
    const res = await authSend(harper, reader, "GET", `/Memory/${DEEP}%252Fbase`);
    const body = await res.json();
    expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(200);
    expect(body.id).toBe(DEEP_BASE);
  }, 30_000);

  for (const spelling of ["%252F", "%252f"]) {
    it(`a non-admin GET of \`${DEEP}${spelling}base.content\` → 400 ambiguous_memory_id, no row served`, async () => {
      const res = await authSend(harper, reader, "GET", `/Memory/${DEEP}${spelling}base.content`);
      const body = await res.json();
      expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(400);
      expect(body.error).toBe("ambiguous_memory_id");
      expect(body.id).toBeUndefined(); // assertion: no record was served
      expect(body.content).toBeUndefined();
    }, 30_000);
  }

  it("a non-admin HEAD of the twice-encoded slash before `.content` → 400 with no body", async () => {
    const res = await authSend(harper, reader, "HEAD", `/Memory/${DEEP}%252Fbase.content`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
  }, 30_000);
});

describe("flair#2307 — the malformed `.content` segment refusal applies whatever the request's credential", () => {
  const readRows = async (ids: string[]) => {
    const res = await adminOp(harper, {
      operation: "search_by_hash", database: "flair", table: "Memory", hash_values: ids, get_attributes: ["*"],
    });
    const text = await res.text();
    expect(res.status, `search_by_hash returned ${res.status}: ${text.slice(0, 200)}`).toBe(200);
    return JSON.parse(text);
  };
  const ids = [BASE, "mcs-bad", MALFORMED, `${MALFORMED}.content`];
  const credentials: Array<[string, () => Record<string, string>]> = [
    ["a Basic admin", () => ({ Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) })],
    ["an anonymous", () => ({})],
  ];
  /** The body as JSON, or the raw text when it is not JSON (Harper's own error page). */
  const bodyOf = async (res: Response) => {
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
  };

  for (const [who, headers] of credentials) {
    it(`${who} GET of a malformed segment ending in \`.content\` → 400 memory_id_content_suffix, no row served`, async () => {
      const res = await fetch(`${harper.httpURL}/Memory/${MALFORMED}.content`, { headers: headers() });
      const body = await bodyOf(res);
      expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(400);
      expect(body.error).toBe("memory_id_content_suffix");
      expect(body.id).toBeUndefined(); // assertion: no record was served
      expect(body.content).toBeUndefined();
    }, 30_000);

    it(`${who} PUT to a malformed segment ending in \`.content\` → 400 memory_id_content_suffix, no row changed`, async () => {
      const before = await readRows(ids);
      const res = await fetch(`${harper.httpURL}/Memory/${MALFORMED}.content`, {
        method: "PUT",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: author.id, content: "CHANGED BODY" }),
      });
      const body = await bodyOf(res);
      expect(res.status, JSON.stringify(body).slice(0, 200)).toBe(400);
      expect(body.error).toBe("memory_id_content_suffix");
      expect(await readRows(ids)).toEqual(before);
    }, 30_000);
  }
});
