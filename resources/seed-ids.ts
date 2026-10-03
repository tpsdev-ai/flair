/**
 * seed-ids.ts — the `using-flair` seed's fixed skill row id (flair#2141 S2).
 *
 * Pure, with no runtime import, so a unit test can read it without a Harper
 * instance. resources/seed-reservation.ts reserves it; src/lib/skill-seed.ts
 * writes it (its `SEED_SKILL_ID` must equal this value, and
 * test/unit/skill-seed.test.ts pins that).
 */
export const SEED_SKILL_ROW_ID = "skill:using-flair";
