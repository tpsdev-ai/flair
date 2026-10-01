/**
 * skill-seed.ts — the `using-flair` seed: the decision, and its install-time
 * write (flair#2141 S2).
 *
 * `flair init` is the install path. It writes BOTH rows as the operator — a
 * verified Basic administrator over the normal signed REST APIs
 * (`PUT /Memory/<id>`, `PUT /OrgSkillAssignment/<id>`) — so the write carries
 * operator provenance and operator authority, with no reserved agent id and no
 * extra route.
 *
 * The rule for the row is small and pure, so it is unit-tested without a server:
 *
 *   - no stored row                   → write the current text;
 *   - stored text = the current text  → unchanged;
 *   - stored text's hash is shipped   → replace (an unedited shipped version);
 *   - otherwise                       → keep, and report it;
 *   - stored content is NOT a string  → refuse (a malformed row is never read
 *                                       as "absent", which would overwrite it);
 *   - a read that FAILS               → refuse (never "absent").
 *
 * An existing assignment whose `skillRef` is not the skill row's id is refused.
 * Both ids are fixed, so a re-run reads by primary key: it updates the same
 * rows instead of creating duplicates, and a concurrent re-run lands on the
 * same rows too. Every write is checked and read back before success.
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

/** The skill Memory row's id, and the org assignment's `skillRef`. */
export const SEED_SKILL_ID = "skill:using-flair";

/** The org assignment's id. Fixed, so a re-run lands on the same row. */
export const SEED_ASSIGNMENT_ID = "org-skill:using-flair";

/** The org-scope assignment's priority. */
export const SEED_ASSIGNMENT_PRIORITY = "standard";

/** The bound on every seed request, so a stalled instance cannot hang init. */
export const SEED_REQUEST_TIMEOUT_MS = 15_000;

export type SeedAction = "create" | "unchanged" | "replace" | "keep";

/** A skill row as the seed reads it. */
export interface SeedRowShape {
  id?: unknown;
  agentId?: unknown;
  content?: unknown;
}

/** An OrgSkillAssignment row as the seed reads it. */
export interface SeedAssignment {
  id?: unknown;
  skillName?: unknown;
  skillRef?: unknown;
}

/** A read result. `ok:false` means the read FAILED — never "the row is absent". */
export type SeedRead<T> = { ok: boolean; row?: T | null; detail?: string };

/** A write result. `ok:false` carries what failed. */
export type SeedWrite = { ok: boolean; detail?: string };

export interface SkillSeedIo {
  readRow(): Promise<SeedRead<SeedRowShape>>;
  readAssignment(): Promise<SeedRead<SeedAssignment>>;
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

function refused(error: string, message: string): SkillSeedOutcome {
  return { kind: "refused", error, message };
}

/** Apply the seed rule over `io`. Never writes when a read failed. */
export async function runSkillSeed(io: SkillSeedIo, current: SeedCurrent): Promise<SkillSeedOutcome> {
  const rowRead = await io.readRow();
  if (!rowRead.ok) {
    return refused(
      "skill_seed_row_unreadable",
      `the existing "${SEED_SKILL_ID}" skill row could not be read (${rowRead.detail ?? "no detail"}); ` +
        `check the instance and re-run 'flair init'`,
    );
  }
  const stored = rowRead.row ?? null;
  if (stored && typeof stored.content !== "string") {
    return refused(
      "skill_seed_row_malformed",
      `the Memory row "${SEED_SKILL_ID}" exists but its content is not text; ` +
        `give it text or delete the row, then re-run 'flair init'`,
    );
  }
  const storedContent = typeof stored?.content === "string" ? stored.content : null;

  const assignRead = await io.readAssignment();
  if (!assignRead.ok) {
    return refused(
      "skill_seed_assignment_unreadable",
      `the existing "${SEED_ASSIGNMENT_ID}" org assignment could not be read (${assignRead.detail ?? "no detail"}); ` +
        `check the instance and re-run 'flair init'`,
    );
  }
  if (assignRead.row && assignRead.row.skillRef !== SEED_SKILL_ID) {
    return refused(
      "skill_seed_assignment_mismatch",
      `the org assignment "${SEED_ASSIGNMENT_ID}" names ${JSON.stringify(assignRead.row.skillRef)} ` +
        `instead of "${SEED_SKILL_ID}"; delete it or re-point it, then re-run 'flair init'`,
    );
  }

  const action = decideSkillSeed(storedContent, current.content, current.hashes);
  if (action === "create" || action === "replace") {
    const write = await io.putRow();
    if (!write.ok) {
      return refused(
        "skill_seed_write_failed",
        `writing the "${SEED_SKILL_ID}" skill row failed (${write.detail ?? "no detail"}); re-run 'flair init'`,
      );
    }
    const after = await io.readRow();
    if (!after.ok) {
      return refused(
        "skill_seed_verify_failed",
        `the "${SEED_SKILL_ID}" skill row could not be read back after the write (${after.detail ?? "no detail"}); ` +
          `check the instance and re-run 'flair init'`,
      );
    }
    if (after.row?.id !== SEED_SKILL_ID || after.row?.content !== current.content) {
      return refused(
        "skill_seed_verify_failed",
        `the "${SEED_SKILL_ID}" skill row does not hold the current text after the write; ` +
          `check the Memory table and re-run 'flair init'`,
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
    if (after.row?.id !== SEED_ASSIGNMENT_ID || after.row?.skillRef !== SEED_SKILL_ID) {
      return refused(
        "skill_seed_verify_failed",
        `the "${SEED_ASSIGNMENT_ID}" org assignment does not point at "${SEED_SKILL_ID}" after the write; ` +
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
          : `using-flair was locally modified or is not a shipped version; kept it unchanged (${SEED_SKILL_ID})`;

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
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  const readById = async (table: string, id: string): Promise<SeedRead<SeedRowShape>> => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/${table}/${encodeURIComponent(id)}`, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(SEED_REQUEST_TIMEOUT_MS),
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
      return { ok: true, row: parsed as SeedRowShape };
    } catch {
      return { ok: false, detail: "the response was not JSON" };
    }
  };

  const putById = async (table: string, id: string, body: unknown): Promise<SeedWrite> => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/${table}/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEED_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, detail: `the request failed: ${detailOf(err)}` };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, detail: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }
    return { ok: true };
  };

  return {
    readRow: () => readById("Memory", SEED_SKILL_ID),
    readAssignment: () => readById("OrgSkillAssignment", SEED_ASSIGNMENT_ID),
    putRow: () => putById("Memory", SEED_SKILL_ID, seedSkillBody(opts.user, current)),
    putAssignment: () =>
      putById("OrgSkillAssignment", SEED_ASSIGNMENT_ID, {
        skillName: current.name,
        skillRef: SEED_SKILL_ID,
        priority: current.priority,
      }),
  };
}

/**
 * Seed `using-flair` on the instance at `baseUrl`, as the operator. The one
 * call `flair init` makes: it reports what it did, or refuses with a remedy.
 */
export function seedUsingFlairSkill(opts: SkillSeedRestOptions): Promise<SkillSeedOutcome> {
  return runSkillSeed(skillSeedRestIo(opts), currentSeed());
}
