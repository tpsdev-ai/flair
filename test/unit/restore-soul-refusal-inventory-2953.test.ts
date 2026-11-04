/**
 * restore-soul-refusal-inventory-2953.test.ts — the Soul write-refusal
 * inventory behind `flair restore --replace` (flair#2953).
 *
 * The replace preflight in src/commands/restore.ts duplicates the server's
 * Soul write policy. A refusal added to the write path after the preflight
 * would reopen the delete-then-refused window, so this inventory reads the
 * source of every module that path calls and fails when a code it finds is
 * neither preflighted, refused by archive admission, nor named out of scope
 * here. The codes come from the source, not from a hand-written list alone.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

/** Every module the Soul PUT/PATCH path calls that constructs a refusal. */
const SOURCES = [
  "resources/Soul.ts",
  "resources/soul-write-policy.ts",
  "resources/skill-provenance.ts",
  "resources/originator-instance.ts",
  "resources/owner-field-guard.ts",
  "resources/record-owner-guard.ts",
  "resources/instruction-version-record.ts",
  "src/lib/soul-scope-fields.ts",
] as const;

/** Named refusal codes as they appear in the write-path source. */
function sourceCodes(): Set<string> {
  const codes = new Set<string>();
  for (const file of SOURCES) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(/\b(?:soul|skill|stored|owner|id|instruction)_[a-z0-9_]+\b/g)) codes.add(match[0]);
    // The fixed 401 body is returned through a bare UNAUTH() call.
    if (/\bUNAUTH\(\)/.test(source)) codes.add("authentication required");
    // The owner guard and the attribution stamp carry their refusal as a
    // fixed message, not a snake_case name.
    for (const match of source.matchAll(/"((?:forbidden)[^"]*)"/g)) codes.add(match[1]);
  }
  return codes;
}

/** Refusal codes `restore --replace` decides before its first delete. */
const PREFLIGHTED = [
  "soul_scope_fields_not_writable", // suppliesSoulScopeFields in src/commands/restore.ts
  "soul_value_is_learned_content", // LEARNED_REFUSAL plus the Memory and candidate comparisons
  "skill_source_not_durable", // refuseSkillAssignmentWrite in src/lib/skill-assignment-preflight.ts
  "skill_opt_out_not_boolean", // the same predicate
] as const;

/** Codes archive admission already refuses, each with the check that covers it. */
const ADMISSION = new Map<string, string>([
  ["soul_owner_required", "rowShapeProblem refuses a Soul row whose agentId is not a non-empty string"],
]);

/** Codes the preflight deliberately leaves to the write, with the reason. */
const OUT_OF_SCOPE = new Map<string, string>([
  ["soul_write_requires_one_record", "body-shape guard: both the preflight and the write send the archive row as an object"],
  ["soul_write_requires_operator", "write authorization: the preflight and the write use the same admin credentials"],
  ["authentication required", "anonymous 401: the preflight and the write use the same admin credentials"],
  ["forbidden: agentId must match authenticated agent", "attribution guard: an admin credential takes the passthrough branch"],
  ["forbidden: the owner of a record cannot be changed", "owner-field guard: an admin credential takes the passthrough branch"],
  ["owner_check_unavailable", "owner-field guard: its read runs only for a non-admin caller"],
  ["id_target_mismatch", "body-id/address disagreement: restore addresses each row by its own id"],
  ["stored_row_lookup_failed", "stored-row read failure at the write, which the preflight does not perform"],
  ["soul_delete_requires_one_record", "DELETE-only: restore --replace addresses each Soul row by its single-record id"],
  ["soul_stored_state_unavailable", "PATCH-only: restore --replace PUTs rows and never PATCHes"],
  ["soul_patch_table_unavailable", "PATCH-only: restore --replace PUTs rows and never PATCHes"],
  ["soul_patch_conflict", "PATCH-only: restore --replace PUTs rows and never PATCHes"],
  ["soul_patch_row_changed", "PATCH-only: restore --replace PUTs rows and never PATCHes"],
  ["soul_subject_occupied", "identity-change path: the replace PUT has no stored row, so its identity did not change"],
  ["instruction_version_head_mismatch", "compare-and-set: the replace PUT supplies no expectedVersion"],
  ["instruction_version_append_failed", "commit-time version append failure, which the preflight cannot predict"],
  ["instruction_version_busy", "commit-time version lock contention, which the preflight cannot predict"],
  ["instruction_version_lock_unavailable", "commit-time version lock availability, which the preflight cannot predict"],
]);

test("every named refusal code in the Soul write path is preflighted, admission-refused or explicitly out of scope", () => {
  const found = sourceCodes();
  const listed = new Set<string>([...PREFLIGHTED, ...ADMISSION.keys(), ...OUT_OF_SCOPE.keys()]);

  for (const check of ADMISSION.values()) expect(check.trim()).not.toBe("");
  const unclassified = [...found].filter((code) => !listed.has(code)).sort();
  expect(unclassified).toEqual([]);
  const unlisted = [...listed].filter((code) => !found.has(code)).sort();
  expect(unlisted).toEqual([]);
  expect(found.size).toBe(listed.size);
});

test("restore --replace names each preflighted Soul write rule", () => {
  const source = readFileSync(join(root, "src/commands/restore.ts"), "utf8");
  for (const marker of [
    "suppliesSoulScopeFields(row)",
    "LEARNED_REFUSAL",
    "refuseSkillAssignmentWrite(row)",
  ]) {
    expect(source).toContain(marker);
  }
});
