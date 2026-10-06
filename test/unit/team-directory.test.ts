/**
 * team-directory.test.ts — the ONE team-directory resolver (flair#2141 S3a).
 *
 * Drives resources/team-directory.ts directly against a mocked `harper`
 * `databases.flair` surface (the same technique as
 * test/unit/integration-read-gate.test.ts) and pins:
 *   - the verified-active-reader gate (anonymous / missing context / inactive
 *     reader get nothing);
 *   - filtering before pagination (active agent-kind principals, matching
 *     contact owner, tps-mail platform, valid publication stamps, tombstones
 *     excluded, one channel per agent);
 *   - the caps (50 entries, 256 UTF-8 bytes for agentId/name/email, 64 KiB response);
 *   - pagination;
 *   - unavailable storage is a 503, never an empty success;
 *   - the CLI vocabulary matches the Peer.status schema comment and
 *     omits `active` (an Instance.status value).
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let agents = new Map<string, any>();
let integrations = new Map<string, any>();
let failAgentStore = false;
let failIntegrationStore = false;

const Agent = {
  async get(id: string) {
    if (failAgentStore) throw new Error("agent store down");
    return agents.get(id) ?? null;
  },
  search() {
    if (failAgentStore) throw new Error("agent store down");
    async function* gen() {
      for (const a of agents.values()) yield a;
    }
    return gen();
  },
};

const Integration = {
  search() {
    if (failIntegrationStore) throw new Error("integration store down");
    async function* gen() {
      for (const i of integrations.values()) yield i;
    }
    return gen();
  },
};

const databasesMock = { flair: { Agent, Integration } };

mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  databases: databasesMock,
  Resource: class {},
}));

const {
  resolveTeamDirectory,
  isActiveAgentPrincipal,
  isValidPublicationStamp,
  normalizeLimit,
  utf8Bytes,
  TEAM_DIRECTORY_MAX_ENTRIES,
  TEAM_DIRECTORY_MAX_STRING_BYTES,
  TEAM_DIRECTORY_MAX_RESPONSE_BYTES,
  TEAM_DIRECTORY_PLATFORM,
} = await import("../../resources/team-directory.ts");
const { PEER_STATUS, PEER_STATUS_VALUES, PEER_MEMBERSHIP_STATUSES, isPeerMemberStatus } =
  await import("../../src/lib/peer-status.ts");

const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

function addAgent(id: string, extra: Record<string, unknown> = {}) {
  agents.set(id, { id, kind: "agent", status: "active", name: id, ...extra });
}

function addContact(id: string, fields: Record<string, unknown>) {
  integrations.set(id, { platform: TEAM_DIRECTORY_PLATFORM, ...fields });
}

beforeEach(() => {
  agents = new Map();
  integrations = new Map();
  failAgentStore = false;
  failIntegrationStore = false;
});

describe("gate — the verified-active-reader gate", () => {
  it("anonymous gets 401", async () => {
    const res = await resolveTeamDirectory(anonCtx());
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(401);
  });

  it("a missing context grants nothing (403, not internal)", async () => {
    const res = await resolveTeamDirectory(undefined);
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
  });

  it("a verified reader whose Agent row is inactive gets 403", async () => {
    addAgent("reader", { status: "deactivated" });
    const res = await resolveTeamDirectory(agentCtx("reader"));
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
  });

  it("a verified reader absent from the Agent table gets 403", async () => {
    const res = await resolveTeamDirectory(agentCtx("ghost"));
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(403);
  });

  it("an active verified reader with no contacts gets an empty (not refused) page", async () => {
    addAgent("reader");
    const res = await resolveTeamDirectory(agentCtx("reader"));
    expect(res instanceof Response).toBe(false);
    expect((res as any).entries).toEqual([]);
  });

  it("a failed Agent read is 503, never an empty success", async () => {
    failAgentStore = true;
    const res = await resolveTeamDirectory(agentCtx("reader"));
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(503);
  });

  it("a failed Integration read is 503, never a silently-empty directory", async () => {
    addAgent("reader");
    failIntegrationStore = true;
    const res = await resolveTeamDirectory(agentCtx("reader"));
    expect(res instanceof Response).toBe(true);
    expect((res as Response).status).toBe(503);
  });
});

describe("filtering happens before pagination", () => {
  it("returns only active agent-kind principals with a published tps-mail contact", async () => {
    addAgent("reader");
    addAgent("agent-a");
    addAgent("agent-human", { kind: "human" });
    addAgent("agent-old", { status: "deactivated" });
    addContact("c1", { agentId: "agent-a", email: "a@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    addContact("c2", { agentId: "agent-human", email: "h@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    addContact("c3", { agentId: "agent-old", email: "o@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    const res = (await resolveTeamDirectory(agentCtx("reader"))) as any;
    expect(res.entries.map((e: any) => e.agentId)).toEqual(["agent-a"]);
  });

  it("excludes tombstones (a null/absent publication stamp) and non-tps-mail platforms", async () => {
    addAgent("reader");
    addAgent("agent-a");
    addAgent("agent-b");
    addContact("c1", { agentId: "agent-a", email: "a@example.test", directoryPublishedAt: null });
    addContact("c2", { agentId: "agent-b", email: "b@example.test", platform: "slack", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    const res = (await resolveTeamDirectory(agentCtx("reader"))) as any;
    expect(res.entries).toEqual([]);
  });

  it("keeps one channel per agent — the most recently published", async () => {
    addAgent("reader");
    addAgent("agent-a");
    addContact("c1", { agentId: "agent-a", email: "old@example.test", directoryPublishedAt: "2026-01-01T00:00:00.000Z" });
    addContact("c2", { agentId: "agent-a", email: "new@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    const res = (await resolveTeamDirectory(agentCtx("reader"))) as any;
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].email).toBe("new@example.test");
  });

  it("keeps the later publication time when a non-ISO-8601 stamp sorts before an earlier ISO-8601 one", async () => {
    addAgent("reader");
    addAgent("agent-a");
    const earlier = "2026-10-01T00:00:00.000Z";
    const laterNonIso = "10/03/2026"; // later in time, but sorts BEFORE `earlier` as a string
    expect(Date.parse(laterNonIso)).toBeGreaterThan(Date.parse(earlier));
    expect(laterNonIso < earlier).toBe(true);
    addContact("c1", { agentId: "agent-a", email: "earlier@example.test", directoryPublishedAt: earlier });
    addContact("c2", { agentId: "agent-a", email: "later@example.test", directoryPublishedAt: laterNonIso });
    const res = (await resolveTeamDirectory(agentCtx("reader"))) as any;
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].email).toBe("later@example.test");
    expect(res.entries[0].publishedAt).toBe(new Date(Date.parse(laterNonIso)).toISOString());
  });

  it("filters by exact id and by name substring", async () => {
    addAgent("reader");
    addAgent("agent-a", { name: "Alpha" });
    addAgent("agent-b", { name: "Beta" });
    addContact("c1", { agentId: "agent-a", email: "a@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    addContact("c2", { agentId: "agent-b", email: "b@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    const byId = (await resolveTeamDirectory(agentCtx("reader"), { id: "agent-b" })) as any;
    expect(byId.entries.map((e: any) => e.agentId)).toEqual(["agent-b"]);
    const byName = (await resolveTeamDirectory(agentCtx("reader"), { name: "alph" })) as any;
    expect(byName.entries.map((e: any) => e.agentId)).toEqual(["agent-a"]);
  });

  it("carries a home instance (a resolvable string id, or null when unresolvable)", async () => {
    addAgent("reader");
    addAgent("agent-a");
    addContact("c1", { agentId: "agent-a", email: "a@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    const res = (await resolveTeamDirectory(agentCtx("reader"))) as any;
    expect("homeInstanceId" in res.entries[0]).toBe(true);
    const home = res.entries[0].homeInstanceId;
    expect(home === null || typeof home === "string").toBe(true);
  });
});

describe("caps and pagination", () => {
  it("pages mixed-case IDs without omissions or duplicates", async () => {
    addAgent("reader");
    for (const id of ["a", "A", "b", "B", "\u{10000}", "\uE000"]) {
      addAgent(id);
      addContact(id, { agentId: id, email: `${id}@example.test`, directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const page = (await resolveTeamDirectory(agentCtx("reader"), { limit: 1, cursor })) as any;
      expect(page.entries).toHaveLength(1);
      ids.push(page.entries[0].agentId);
      expect(page.hasMore).toBe(i < 5);
      expect(page.nextCursor).toBe(i < 5 ? page.entries[0].agentId : null);
      cursor = page.nextCursor;
    }
    expect(ids).toEqual(["A", "B", "a", "b", "\uE000", "\u{10000}"]);
  });
  it("caps entries at 50 and pages with a stable cursor", async () => {
    addAgent("reader");
    for (let i = 0; i < 60; i++) {
      const id = `agent-${String(i).padStart(2, "0")}`;
      addAgent(id);
      addContact(`c-${i}`, { agentId: id, email: `${id}@example.test`, directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    }
    const page1 = (await resolveTeamDirectory(agentCtx("reader"), { limit: 50 })) as any;
    expect(page1.entries).toHaveLength(TEAM_DIRECTORY_MAX_ENTRIES);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(page1.entries[page1.entries.length - 1].agentId);
    const page2 = (await resolveTeamDirectory(agentCtx("reader"), { limit: 50, cursor: page1.nextCursor })) as any;
    expect(page2.entries).toHaveLength(10);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it("re-clamps a requested limit to the maximum", async () => {
    expect(normalizeLimit(1000)).toBe(TEAM_DIRECTORY_MAX_ENTRIES);
    expect(normalizeLimit(0)).toBeNull();
    expect(normalizeLimit("nope")).toBeNull();
  });

  it("drops entries that would exceed the 256-byte string cap", async () => {
    addAgent("reader");
    addAgent("agent-a");
    addAgent("agent-big");
    addContact("c1", { agentId: "agent-a", email: "a@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    addContact("c2", {
      agentId: "agent-big",
      email: "x".repeat(TEAM_DIRECTORY_MAX_STRING_BYTES + 1) + "@example.test",
      directoryPublishedAt: "2026-10-01T00:00:00.000Z",
    });
    const res = (await resolveTeamDirectory(agentCtx("reader"))) as any;
    expect(res.entries.map((e: any) => e.agentId)).toEqual(["agent-a"]);
  });

  it("cuts a long multibyte name to the 256-byte string cap on a code-point boundary", async () => {
    addAgent("reader");
    addAgent("agent-a", { name: "é".repeat(200) }); // 400 UTF-8 bytes
    addContact("c1", { agentId: "agent-a", email: "a@example.test", directoryPublishedAt: "2026-10-01T00:00:00.000Z" });
    const res = (await resolveTeamDirectory(agentCtx("reader"))) as any;
    expect(res.entries[0].name).toBe("é".repeat(128));
    expect(utf8Bytes(res.entries[0].name)).toBe(TEAM_DIRECTORY_MAX_STRING_BYTES);
  });

  it("trims an over-cap candidate and resumes at the last returned entry", async () => {
    addAgent("reader");
    const candidate = [];
    for (let i = 0; i < 50; i++) {
      const id = `agent-${String(i).padStart(2, "0")}${"x".repeat(248)}`;
      const name = "\u0001".repeat(256);
      const email = "\u0002" + "x".repeat(255);
      const publishedAt = "2026-10-01T00:00:00.000Z";
      addAgent(id, { name });
      addContact(`c-${i}`, { agentId: id, email, directoryPublishedAt: publishedAt });
      candidate.push({ agentId: id, name, email, publishedAt, platform: TEAM_DIRECTORY_PLATFORM, homeInstanceId: null });
    }
    expect(utf8Bytes(JSON.stringify({ entries: candidate, nextCursor: null, hasMore: false, limit: 50, generatedAt: "2026-10-01T00:00:00.000Z" })))
      .toBeGreaterThan(65_536);
    const res = (await resolveTeamDirectory(agentCtx("reader"), { limit: 50 })) as any;
    expect(utf8Bytes(JSON.stringify(res))).toBeLessThanOrEqual(TEAM_DIRECTORY_MAX_RESPONSE_BYTES);
    expect(res.entries.length).toBeGreaterThan(0);
    expect(res.entries.length).toBeLessThan(50);
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe(res.entries.at(-1).agentId);
    const ids = res.entries.map((entry: any) => entry.agentId);
    let page = res;
    for (let i = 0; page.hasMore && i < 50; i++) {
      page = await resolveTeamDirectory(agentCtx("reader"), { limit: 50, cursor: page.nextCursor });
      expect(page.entries.length).toBeGreaterThan(0);
      expect(utf8Bytes(JSON.stringify(page))).toBeLessThanOrEqual(TEAM_DIRECTORY_MAX_RESPONSE_BYTES);
      ids.push(...page.entries.map((entry: any) => entry.agentId));
    }
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(ids).toEqual(candidate.map((entry) => entry.agentId));
  });
});

describe("pure helpers", () => {
  it("isActiveAgentPrincipal accepts missing kind/status fields", () => {
    expect(isActiveAgentPrincipal({ id: "a" })).toBe(true);
    expect(isActiveAgentPrincipal({ id: "a", kind: "agent", status: "active" })).toBe(true);
    expect(isActiveAgentPrincipal({ id: "a", kind: "human" })).toBe(false);
    expect(isActiveAgentPrincipal({ id: "a", status: "suspended" })).toBe(false);
    expect(isActiveAgentPrincipal({ id: "" })).toBe(false);
    expect(isActiveAgentPrincipal(null)).toBe(false);
  });

  it("isValidPublicationStamp accepts only parseable non-empty strings", () => {
    expect(isValidPublicationStamp("2026-10-01T00:00:00.000Z")).toBe(true);
    expect(isValidPublicationStamp("")).toBe(false);
    expect(isValidPublicationStamp(null)).toBe(false);
    expect(isValidPublicationStamp("not-a-date")).toBe(false);
  });
});

describe("documented Peer.status CLI vocabulary (flair#2141 item 6)", () => {
  it("matches the Peer.status comment in schemas/federation.graphql exactly", () => {
    const schema = readFileSync(join(import.meta.dir, "../../schemas/federation.graphql"), "utf8");
    const line = schema.split("\n").find((l) => l.includes("status: String") && l.includes("paired"));
    expect(line).toBeDefined();
    const quoted = [...line!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(quoted).toEqual([...PEER_STATUS_VALUES]);
  });

  it("the classifier excludes revoked and active", () => {
    expect(PEER_MEMBERSHIP_STATUSES).toEqual([PEER_STATUS.PAIRED, PEER_STATUS.CONNECTED, PEER_STATUS.DISCONNECTED]);
    expect(isPeerMemberStatus(PEER_STATUS.REVOKED)).toBe(false);
    expect(isPeerMemberStatus("active")).toBe(false);
    expect(PEER_STATUS_VALUES as readonly string[]).not.toContain("active");
  });

  it("the CLI imports the classifier and omits the retired color condition", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/commands/federation.ts"), "utf8");
    expect(src).toContain('from "../lib/peer-status.js"');
    // The retired literal: `active` used to color a peer status green.
    expect(src).not.toContain('s === "paired" || s === "connected" || s === "active"');
  });
});
