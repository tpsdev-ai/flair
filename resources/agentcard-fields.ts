// Pure selection logic for what an agent's public AgentCard exposes.
//
// SECURITY: `GET /AgentCard/{id}` is intentionally UNAUTHENTICATED (A2A spec —
// agent cards are public discovery metadata, and the auth-middleware allow-list
// lets it bypass auth). Everything these helpers return is therefore world-
// readable. They must publish ONLY explicitly-kinded souls — never an implicit
// fallback that could surface a private soul (an operator's internal note,
// prompt fragment, or credential reminder) on the public endpoint.
//
// Kept free of any @harperfast/harper import so the real logic is unit-testable
// without spinning up Harper (avoids the simulator-pattern that let the
// description-fallback leak ship untested).

export type SoulLike = {
  key?: string;
  value?: string;
  kind?: string;
  content?: string;
};

export function readSoulKind(entry: SoulLike): string {
  return String(entry.kind ?? entry.key ?? "").trim().toLowerCase();
}

export function readSoulContent(entry: SoulLike): string {
  return String(entry.content ?? entry.value ?? "").trim();
}

/**
 * The public description is ONLY an explicit `kind="description"` soul.
 *
 * There is deliberately no fallback to "the first soul with any content": that
 * was the description-fallback leak — an agent with no description soul would publish an
 * arbitrary private soul on the unauthenticated card. Absent an explicit
 * description, publish nothing.
 */
export function selectPublicDescription(souls: SoulLike[]): string {
  const entry = souls.find((s) => readSoulKind(s) === "description" && readSoulContent(s));
  return entry ? readSoulContent(entry) : "";
}

/**
 * Public skills are ONLY `kind="capability"` souls — an explicit, operator-
 * intended allow-list. Any other soul kind is never published.
 */
export function selectPublicSkills(souls: SoulLike[]): string[] {
  return souls
    .filter((s) => readSoulKind(s) === "capability")
    .map((s) => readSoulContent(s))
    .filter(Boolean);
}
