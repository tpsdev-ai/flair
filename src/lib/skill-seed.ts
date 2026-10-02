/**
 * skill-seed.ts — the `using-flair` seed: the decision, and its install-time
 * write (flair#2141 S2).
 *
 * A normal `flair init` writes both rows; local `--skip-start` on the default
 * install defers them to a later `flair start` that has the admin credential
 * (FLAIR_ADMIN_PASS or the admin-pass file; without one that start warns and
 * leaves the seed pending). Re-runs may find both rows already
 * current. Writes use
 * a verified Basic administrator over authenticated Basic REST requests
 * (`PUT /Memory/<id>`, `PUT /OrgSkillAssignment/<id>`) — so the rows carry
 * the operator's id. Resource write paths check the operator source (Basic
 * administrator or deliberate internal call) for the fixed ids. The Memory
 * reservation has documented bookkeeping writes (resources/seed-reservation.ts,
 * resources/OrgSkillAssignment.ts).
 *
 * Before it writes anything, the seed refuses:
 *   - a read that FAILS (never read as "absent");
 *   - an Agent record whose id is the operator's: a row owned by that id could
 *     have been written by the agent, so its owner is ambiguous;
 *   - an existing skill row not owned by the operator;
 *   - an existing skill row whose content is not text, or that is not a live
 *     org skill: no `skill` tag, durability not `persistent`, visibility not
 *     `shared`, archived, closed (`validTo`) or expired (`expiresAt`), or
 *     another id;
 *   - an existing assignment with another id, `skillRef`, `skillName` or
 *     priority.
 *
 * Otherwise the rule for the row is small and pure, so it is unit-tested
 * without a server:
 *
 *   - no stored row                   → write the current text;
 *   - stored text = the current text  → unchanged;
 *   - stored text's hash is listed    → replace (the text matches a listed
 *                                       shipped version);
 *   - otherwise                       → keep, and report it.
 *
 * Both ids are fixed, so a re-run reads by primary key and updates the same
 * rows instead of adding rows. After each write the seed reads the row back
 * and applies the same checks; it reports success only when both rows pass.
 *
 * The IO seam is a tiny REST client, so the fail-closed contract is testable
 * without a server and the real path is the one `flair init` runs.
 */
import {
  USING_FLAIR_SKILL_CONTENT,
  USING_FLAIR_SKILL_NAME,
  USING_FLAIR_SKILL_TRIGGER,
  USING_FLAIR_SHIPPED_HASHES,
  usingFlairSkillHash,
} from "./using-flair-skill.js";

/**
 * The skill Memory row's id, and the org assignment's `skillRef`. Must equal
 * `SEED_SKILL_ROW_ID` in resources/seed-ids.ts (a unit test pins it).
 */
export const SEED_SKILL_ID = "skill:using-flair";

/** The org assignment's id. Fixed, so a re-run lands on the same row. */
export const SEED_ASSIGNMENT_ID = "org-skill:using-flair";

/** The org-scope assignment's priority. */
export const SEED_ASSIGNMENT_PRIORITY = "standard";

/**
 * The bound on the seed's reads and on its assignment write, so a stalled
 * instance cannot hang init.
 */
export const SEED_REQUEST_TIMEOUT_MS = 15_000;

/**
 * The bound on the skill row's write. The instance embeds a skill row as it
 * writes it (`Memory.put` awaits `getEmbedding`), and the first embed awaits
 * the embedding model's readiness: a first start may download the model
 * (~80 MB) and load it in the background, and Harper can report healthy before
 * that ends. So this one write can outlast the 15 s bound on a healthy instance.
 * The 180 s limit bounds the wait; it does not guarantee a download completes.
 * It stays under the 300 s default headers timeout of Node's fetch, so this
 * bound and its message fire first.
 */
export const SEED_SKILL_WRITE_TIMEOUT_MS = 180_000;

/** How long the skill row's write runs before init says what it is waiting on. */
export const SEED_SKILL_WRITE_NOTICE_MS = 5_000;

export type SeedAction = "create" | "unchanged" | "replace" | "keep";

/** A skill row as the seed reads it. */
export interface SeedRowShape {
  id?: unknown;
  agentId?: unknown;
  content?: unknown;
  tags?: unknown;
  durability?: unknown;
  visibility?: unknown;
  archived?: unknown;
  validTo?: unknown;
  expiresAt?: unknown;
}

/** An OrgSkillAssignment row as the seed reads it. */
export interface SeedAssignment {
  id?: unknown;
  skillName?: unknown;
  skillRef?: unknown;
  priority?: unknown;
}

/** A read result. `ok:false` means the read FAILED — never "the row is absent". */
export type SeedRead<T> = { ok: boolean; row?: T | null; detail?: string };

/** A write result. `ok:false` carries what failed. */
export type SeedWrite = { ok: boolean; detail?: string };

export interface SkillSeedIo {
  /** The operator principal the writes run as: the Basic administrator's username. */
  operator: string;
  readRow(): Promise<SeedRead<SeedRowShape>>;
  readAssignment(): Promise<SeedRead<SeedAssignment>>;
  /** The Agent record whose id equals `operator`; `row: null` when there is none. */
  readOperatorAgent(): Promise<SeedRead<unknown>>;
  putRow(): Promise<SeedWrite>;
  putAssignment(): Promise<SeedWrite>;
}

export type SkillSeedOutcome =
  | { kind: "ok"; action: SeedAction; skillId: string; assignmentId: string; message: string }
  | { kind: "refused"; error: string; message: string };

/** The shipped text and hashes this seed writes. */
export interface SeedCurrent {
  name: string;
  content: string;
  trigger: string;
  hashes: readonly string[];
  priority: string;
}

/** The shipped `using-flair` skill as this build defines it. */
export function currentSeed(): SeedCurrent {
  return {
    name: USING_FLAIR_SKILL_NAME,
    content: USING_FLAIR_SKILL_CONTENT,
    trigger: USING_FLAIR_SKILL_TRIGGER,
    hashes: USING_FLAIR_SHIPPED_HASHES,
    priority: SEED_ASSIGNMENT_PRIORITY,
  };
}

/**
 * The decision for one seeding pass. `stored` is the row's `content`, or null
 * when the row does not exist.
 */
export function decideSkillSeed(
  stored: string | null,
  currentContent: string,
  shippedHashes: readonly string[],
  currentHash: string = usingFlairSkillHash(currentContent),
): SeedAction {
  if (stored === null) return "create";
  const hash = usingFlairSkillHash(stored);
  if (hash === currentHash) return "unchanged";
  if (shippedHashes.includes(hash)) return "replace";
  return "keep";
}

function isPast(value: unknown, now: number): boolean {
  return typeof value === "string" && value.length > 0 && Date.parse(value) < now;
}

/**
 * What keeps a stored skill row from being the live org `using-flair` skill
 * that bootstrap's manifest resolves (resources/skill-manifest.ts,
 * resolvableSkillRows), or [] when nothing does. Ownership and content are
 * checked separately.
 */
export function seedRowProblems(row: SeedRowShape, now: number = Date.now()): string[] {
  const problems: string[] = [];
  if (row.id !== SEED_SKILL_ID) problems.push(`its id is ${JSON.stringify(row.id ?? null)}`);
  if (!Array.isArray(row.tags) || !row.tags.includes("skill")) problems.push('it has no "skill" tag');
  if (row.durability !== "persistent") problems.push(`its durability is ${JSON.stringify(row.durability ?? null)}, not "persistent"`);
  if (row.visibility !== "shared") problems.push(`its visibility is ${JSON.stringify(row.visibility ?? null)}, not "shared"`);
  if (row.archived === true) problems.push("it is archived");
  if (isPast(row.validTo, now)) problems.push("it is closed (validTo is past)");
  if (isPast(row.expiresAt, now)) problems.push("it has expired (expiresAt is past)");
  return problems;
}

/** What makes a stored org assignment differ from the seed's, or [] when nothing does. */
export function seedAssignmentProblems(row: SeedAssignment, current: SeedCurrent): string[] {
  const problems: string[] = [];
  if (row.id !== SEED_ASSIGNMENT_ID) problems.push(`its id is ${JSON.stringify(row.id ?? null)}`);
  if (row.skillRef !== SEED_SKILL_ID) problems.push(`it names ${JSON.stringify(row.skillRef ?? null)} instead of "${SEED_SKILL_ID}"`);
  if (row.skillName !== current.name) problems.push(`its skillName is ${JSON.stringify(row.skillName ?? null)}, not "${current.name}"`);
  if (row.priority !== current.priority) problems.push(`its priority is ${JSON.stringify(row.priority ?? null)}, not "${current.priority}"`);
  return problems;
}

function refused(error: string, message: string): SkillSeedOutcome {
  return { kind: "refused", error, message };
}

const NOTHING_WRITTEN = "the seed wrote neither seed row";
const ROW_PATH = `/Memory/${encodeURIComponent(SEED_SKILL_ID)}`;
const ASSIGNMENT_PATH = `/OrgSkillAssignment/${encodeURIComponent(SEED_ASSIGNMENT_ID)}`;
const ROW_REMEDY =
  `Inspect it (GET ${ROW_PATH}), delete it with the operator's Basic credentials (DELETE ${ROW_PATH}), ` +
  "then re-run 'flair init'";
const ASSIGNMENT_REMEDY =
  `Inspect it (GET ${ASSIGNMENT_PATH}), correct or delete it with the operator's Basic credentials, ` +
  "then re-run 'flair init'";

/** Apply the seed rule over `io`. Preflight reads and checks pass before either write. */
export async function runSkillSeed(io: SkillSeedIo, current: SeedCurrent): Promise<SkillSeedOutcome> {
  const rowRead = await io.readRow();
  if (!rowRead.ok) {
    return refused(
      "skill_seed_row_unreadable",
      `the "${SEED_SKILL_ID}" Memory row could not be read (${rowRead.detail ?? "no detail"}); ${NOTHING_WRITTEN}. ` +
        "Check the instance and re-run 'flair init'",
    );
  }

  const agentRead = await io.readOperatorAgent();
  if (!agentRead.ok) {
    return refused(
      "skill_seed_operator_unreadable",
      `the Agent record for the operator id "${io.operator}" could not be read (${agentRead.detail ?? "no detail"}); ` +
        `${NOTHING_WRITTEN}. Check the instance and re-run 'flair init'`,
    );
  }
  // Checked before any write, with or without a stored row: a row init wrote
  // now would be refused by the next run for the same reason.
  if (agentRead.row) {
    return refused(
      "skill_seed_operator_ambiguous",
      `an Agent record has the operator's id "${io.operator}", so a skill row owned by "${io.operator}" cannot be ` +
        `told apart from one that agent wrote; ${NOTHING_WRITTEN}. Rename or remove that agent, then re-run 'flair init'`,
    );
  }

  const stored = rowRead.row ?? null;
  if (stored) {
    if (stored.agentId !== io.operator) {
      return refused(
        "skill_seed_row_foreign_owner",
        `the "${SEED_SKILL_ID}" Memory row is owned by ${JSON.stringify(stored.agentId ?? null)}, not the operator ` +
          `"${io.operator}"; ${NOTHING_WRITTEN}. ${ROW_REMEDY}`,
      );
    }
    if (typeof stored.content !== "string") {
      return refused(
        "skill_seed_row_malformed",
        `the "${SEED_SKILL_ID}" Memory row exists but its content is not text; ${NOTHING_WRITTEN}. ${ROW_REMEDY}`,
      );
    }
    const problems = seedRowProblems(stored);
    if (problems.length > 0) {
      return refused(
        "skill_seed_row_incomplete",
        `the "${SEED_SKILL_ID}" Memory row is not a live org skill: ${problems.join("; ")}; ${NOTHING_WRITTEN}. ${ROW_REMEDY}`,
      );
    }
  }
  const storedContent = typeof stored?.content === "string" ? stored.content : null;

  const assignRead = await io.readAssignment();
  if (!assignRead.ok) {
    return refused(
      "skill_seed_assignment_unreadable",
      `the "${SEED_ASSIGNMENT_ID}" org assignment could not be read (${assignRead.detail ?? "no detail"}); ` +
        `${NOTHING_WRITTEN}. Check the instance and re-run 'flair init'`,
    );
  }
  if (assignRead.row) {
    const problems = seedAssignmentProblems(assignRead.row, current);
    if (problems.length > 0) {
      return refused(
        "skill_seed_assignment_mismatch",
        `the "${SEED_ASSIGNMENT_ID}" org assignment ${problems.join("; ")}; ${NOTHING_WRITTEN}. ${ASSIGNMENT_REMEDY}`,
      );
    }
  }

  const action = decideSkillSeed(storedContent, current.content, current.hashes);
  if (action === "create" || action === "replace") {
    const write = await io.putRow();
    if (!write.ok) {
      return refused(
        "skill_seed_write_failed",
        `writing the "${SEED_SKILL_ID}" skill row failed (${write.detail ?? "no detail"}); the org assignment was not ` +
          "written. Re-run 'flair init'",
      );
    }
    const after = await io.readRow();
    if (!after.ok) {
      return refused(
        "skill_seed_verify_failed",
        `the "${SEED_SKILL_ID}" skill row could not be read back after the write (${after.detail ?? "no detail"}); ` +
          "the org assignment was not written. Check the instance and re-run 'flair init'",
      );
    }
    const row = after.row ?? null;
    const problems = row ? seedRowProblems(row) : ["it is absent"];
    if (row && row.agentId !== io.operator) problems.push(`it is owned by ${JSON.stringify(row.agentId ?? null)}`);
    if (row && row.content !== current.content) problems.push("it does not hold the current text");
    if (problems.length > 0) {
      return refused(
        "skill_seed_verify_failed",
        `the "${SEED_SKILL_ID}" skill row read back after the write is not the operator's live org skill: ` +
          `${problems.join("; ")}; the org assignment was not written. Check the Memory table and re-run 'flair init'`,
      );
    }
  }

  let assignmentId = String(assignRead.row?.id ?? "");
  if (!assignRead.row) {
    const write = await io.putAssignment();
    if (!write.ok) {
      return refused(
        "skill_seed_write_failed",
        `writing the "${SEED_ASSIGNMENT_ID}" org assignment failed (${write.detail ?? "no detail"}); re-run 'flair init'`,
      );
    }
    const after = await io.readAssignment();
    if (!after.ok) {
      return refused(
        "skill_seed_verify_failed",
        `the "${SEED_ASSIGNMENT_ID}" org assignment could not be read back after the write (${after.detail ?? "no detail"}); ` +
          `check the instance and re-run 'flair init'`,
      );
    }
    const problems = after.row ? seedAssignmentProblems(after.row, current) : ["it is absent"];
    if (problems.length > 0) {
      return refused(
        "skill_seed_verify_failed",
        `the "${SEED_ASSIGNMENT_ID}" org assignment read back after the write ${problems.join("; ")}; ` +
          `check the OrgSkillAssignment table and re-run 'flair init'`,
      );
    }
    assignmentId = String(after.row?.id ?? "");
  }

  const message =
    action === "create"
      ? `seeded the using-flair skill (${SEED_SKILL_ID}) and its org assignment`
      : action === "replace"
        ? `replaced the using-flair skill with the current shipped text (${SEED_SKILL_ID})`
        : action === "unchanged"
          ? `using-flair is already current (${SEED_SKILL_ID})`
          : `the using-flair text matches no listed shipped version; kept it unchanged (${SEED_SKILL_ID})`;

  return { kind: "ok", action, skillId: SEED_SKILL_ID, assignmentId, message };
}

// ─── The REST seam: the writes `flair init` makes as the operator ────────────

export interface SkillSeedRestOptions {
  /** The instance's HTTP base URL. */
  baseUrl: string;
  /** The operator (verified Basic administrator) these writes run as. */
  user: string;
  pass: string;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
  /** Told once, when the skill row's write is still waiting after the notice delay. */
  notify?: (line: string) => void;
  /** The bounds, in ms. Overridable for tests; the defaults are the constants above. */
  requestTimeoutMs?: number;
  skillWriteTimeoutMs?: number;
  skillWriteNoticeMs?: number;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `AbortSignal.timeout` rejects a fetch with a DOMException named "TimeoutError". */
function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError";
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

function authHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function seedSkillBody(operatorId: string, current: SeedCurrent): Record<string, unknown> {
  return {
    id: SEED_SKILL_ID,
    // The operator that runs the seed owns the row, so a non-owner agent is
    // refused on the row's write paths and the row carries real attribution.
    agentId: operatorId,
    content: current.content,
    trigger: current.trigger,
    tags: ["skill"],
    durability: "persistent",
    visibility: "shared",
    metadata: JSON.stringify({ name: current.name }),
  };
}

/** The real IO: REST reads and writes against one instance, as the operator. */
export function skillSeedRestIo(opts: SkillSeedRestOptions, current: SeedCurrent = currentSeed()): SkillSeedIo {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  const auth = authHeader(opts.user, opts.pass);
  const requestMs = opts.requestTimeoutMs ?? SEED_REQUEST_TIMEOUT_MS;
  const skillWriteMs = opts.skillWriteTimeoutMs ?? SEED_SKILL_WRITE_TIMEOUT_MS;
  const skillNoticeMs = opts.skillWriteNoticeMs ?? SEED_SKILL_WRITE_NOTICE_MS;

  const readById = async <T>(table: string, id: string): Promise<SeedRead<T>> => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/${table}/${encodeURIComponent(id)}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(requestMs),
      });
    } catch (err) {
      return { ok: false, detail: `the request failed: ${detailOf(err)}` };
    }
    if (res.status === 404) return { ok: true, row: null };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const text = await res.text().catch(() => "");
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, detail: "the response was not one record" };
      }
      return { ok: true, row: parsed as T };
    } catch {
      return { ok: false, detail: "the response was not JSON" };
    }
  };

  const putById = async (
    table: string,
    id: string,
    body: unknown,
    timeoutMs: number,
    onTimeout: (ms: number) => string = (ms) => `no answer within ${seconds(ms)}`,
  ): Promise<SeedWrite> => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/${table}/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isTimeout(err)) return { ok: false, detail: onTimeout(timeoutMs) };
      return { ok: false, detail: `the request failed: ${detailOf(err)}` };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, detail: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }
    return { ok: true };
  };

  // The skill row's write waits on the instance's embedding model (see
  // SEED_SKILL_WRITE_TIMEOUT_MS), so it gets its own bound and says what it is
  // waiting on. A client-side timeout does not cancel the write on the
  // instance, which may still land it. The id is fixed, so a re-run updates
  // that row rather than adding one; a re-run started while the first write is
  // still pending can send a second PUT to the same id.
  const putRow = async (): Promise<SeedWrite> => {
    const notice = setTimeout(() => {
      opts.notify?.(
        `using-flair skill: still writing "${SEED_SKILL_ID}" — the instance embeds a skill row as it writes it, ` +
          `and it may need to download (~80 MB) and load the embedding model first; waiting up to ${seconds(skillWriteMs)}`,
      );
    }, skillNoticeMs);
    (notice as unknown as { unref?: () => void }).unref?.();
    try {
      return await putById("Memory", SEED_SKILL_ID, seedSkillBody(opts.user, current), skillWriteMs, (ms) =>
        `no answer within ${seconds(ms)} — the instance embeds a skill row as it writes it, so this write also ` +
        `wait for its embedding model to download and load; 'flair doctor' reports embeddings. The write may ` +
        `still land; the id is fixed, so a re-run updates that row rather than adding one`,
      );
    } finally {
      clearTimeout(notice);
    }
  };

  return {
    operator: opts.user,
    readRow: () => readById<SeedRowShape>("Memory", SEED_SKILL_ID),
    readAssignment: () => readById<SeedAssignment>("OrgSkillAssignment", SEED_ASSIGNMENT_ID),
    readOperatorAgent: () => readById<unknown>("Agent", opts.user),
    putRow,
    putAssignment: () =>
      putById(
        "OrgSkillAssignment",
        SEED_ASSIGNMENT_ID,
        {
          skillName: current.name,
          skillRef: SEED_SKILL_ID,
          priority: current.priority,
        },
        requestMs,
      ),
  };
}

/**
 * Seed `using-flair` on the instance at `baseUrl`, as the operator. Used by
 * `flair init` and a pending `flair start`; reports the action or a refusal
 * with a remedy.
 */
export function seedUsingFlairSkill(opts: SkillSeedRestOptions): Promise<SkillSeedOutcome> {
  return runSkillSeed(skillSeedRestIo(opts), currentSeed());
}
