// ─── The /mcp conformance ASSERTION ENGINE (flair#1213, extracted flair#1290) ───
//
// One checker, multiple drivers. `conform()` applies a tool's declarative
// `contract` (resources/mcp-tools.ts) — field shape, forbidden fields, and
// every ToolInvariants entry — to a driven result. Extracted from
// test/integration/mcp-connector-conformance-suite.test.ts when the
// large-store workout (bootstrap-large-store-conformance.test.ts, flair#1290
// step 6) needed the FULL contract against a 270-record store: a re-implemented
// subset over there would have been exactly the partial-coverage drift this
// engine exists to prevent. Behavior is unchanged from the in-suite original;
// only the module boundary moved.
import { expect } from "bun:test";
import type { ToolContract } from "../../resources/mcp-tools";
// The wrapper's OWN token estimator (harper-free single source) — the
// tokenEstimate invariant reconstructs the estimate with the SAME function the
// handler used, so it catches the #1199 double-serialization class without
// being brittle to a future estimator change (Kern #1 / Sherlock #2).
import { estimateTokens } from "../../resources/token-estimate";
// flair#1290 — the wrapper's OWN zero-row no-op classifier: the
// noOpEventsSuppressed invariant asserts against ITS classification of the
// seeded/delivered rows, not against hardcoded fixture strings (which tracked
// the fixture, not the semantic class the #1200 filter suppresses).
import { isZeroRowNoOpEvent } from "../../resources/memory-bootstrap-lib";

type FieldType = "string" | "number" | "boolean" | "object" | "array";
function jsTypeOf(v: any): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}
export function getPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function has(obj: any, key: string): boolean {
  return obj != null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * UNIVERSAL structural check (runs on every tool result): the payload is fully
 * resolved and structured — never a double-serialized JSON string, never a
 * pending Promise, never a stringified object (flair#1199/#1182).
 */
export function assertFullyResolved(toolName: string, result: any): void {
  if (typeof result === "string") {
    let parsed: any;
    try { parsed = JSON.parse(result); } catch { parsed = undefined; }
    expect(
      parsed !== null && typeof parsed === "object",
      `${toolName}: result is a JSON string that parses to an object — double-serialized payload`,
    ).toBe(false);
  }
  const seen = new WeakSet<object>();
  (function walk(v: any, path: string): void {
    if (v == null) return;
    if (typeof v === "object") {
      expect(typeof (v as any).then, `${toolName}: ${path} is a thenable/pending Promise in the payload`).not.toBe("function");
      if (seen.has(v)) return;
      seen.add(v);
      for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
      return;
    }
    if (typeof v === "string") {
      expect(v.includes("[object Object]"), `${toolName}: ${path} contains "[object Object]" (a stringified object)`).toBe(false);
      expect(v.includes("[object Promise]"), `${toolName}: ${path} contains "[object Promise]" (a stringified Promise)`).toBe(false);
    }
  })(result, "result");
}

/**
 * Context conform() needs beyond the result itself (flair#1290):
 * - `args`: the request args the tool was driven with — required to evaluate
 *   hintWhenEmpty entries that reference request args (currentTaskHint keys
 *   off the request; predictedHint requires subjects to have been asked for).
 *   conform() fails LOUDLY when such an entry is declared and args are
 *   missing, rather than skipping it — an unrun check must not look like a
 *   pass.
 * - `seededEvents`: the raw OrgEvent rows the fixture seeded, for the
 *   noOpEventsSuppressed seeded-row leg (delivered events are lean at the
 *   /mcp default — no `detail` — so classifying the raw rows is what makes
 *   the check able to fire there).
 */
export interface ConformOpts {
  args?: Record<string, unknown>;
  seededEvents?: Array<Record<string, unknown>>;
}

/** Apply a tool's full declarative contract to a driven result. */
export function conform(toolName: string, result: any, contract: ToolContract, opts: ConformOpts = {}): void {
  assertFullyResolved(toolName, result);

  for (const f of contract.requiredFields ?? []) {
    expect(result?.[f], `${toolName}: required field '${f}' missing (got ${JSON.stringify(result).slice(0, 220)})`).not.toBeUndefined();
  }
  for (const [f, t] of Object.entries(contract.fieldTypes ?? {})) {
    if (result?.[f] === undefined) continue; // presence is requiredFields' job
    expect(jsTypeOf(result[f]), `${toolName}: field '${f}' should be ${t}`).toBe(t as FieldType);
  }
  for (const f of contract.forbiddenFields ?? []) {
    expect(has(result, f), `${toolName}: forbidden internal field '${f}' leaked over the /mcp surface`).toBe(false);
  }

  const inv = contract.invariants ?? {};

  for (const { count, containers } of inv.countEqualsDelivered ?? []) {
    let total = 0;
    for (const c of containers) {
      const arr = getPath(result, c);
      expect(Array.isArray(arr), `${toolName}: container '${c}' must be an array for count==delivered`).toBe(true);
      total += arr.length;
    }
    const reported = getPath(result, count);
    expect(reported, `${toolName}: ${count} (=${reported}) must equal Σ[${containers.join(", ")}] lengths (=${total})`).toBe(total);
  }

  for (const { path, type } of inv.selfDescribingEmpty ?? []) {
    const v = getPath(result, path);
    expect(v, `${toolName}: ${path} must be present (self-describing empty, never missing/undefined)`).not.toBeUndefined();
    expect(v, `${toolName}: ${path} must not be null`).not.toBeNull();
    expect(jsTypeOf(v), `${toolName}: ${path} must be ${type}`).toBe(type);
  }

  if (inv.dedupSignature) {
    const { container, signatureFields } = inv.dedupSignature;
    const arr = getPath(result, container) ?? [];
    const seen = new Set<string>();
    for (const item of arr) {
      const sig = JSON.stringify(signatureFields.map((f) => {
        const v = item?.[f];
        return Array.isArray(v) ? [...v].sort() : (v ?? null);
      }));
      expect(seen.has(sig), `${toolName}: duplicate '${container}' entry by content-signature ${sig}`).toBe(false);
      seen.add(sig);
    }
  }

  if (inv.tokenEstimate) {
    const { field, excludeKeys } = inv.tokenEstimate;
    const reported = result?.[field];
    expect(typeof reported, `${toolName}: ${field} must be a number`).toBe("number");
    const rest: any = { ...result };
    for (const k of excludeKeys) delete rest[k];
    const expected = estimateTokens(JSON.stringify(rest));
    expect(
      reported,
      `${toolName}: ${field} (=${reported}) must equal the wrapper's OWN estimator over the delivered payload (=${expected}) — same-estimator invariant (#1199)`,
    ).toBe(expected);
  }

  if (inv.budgetCap) {
    const { estimate, budget, tolerance } = inv.budgetCap;
    const est = result?.[estimate];
    const bud = result?.[budget];
    expect(typeof est, `${toolName}: ${estimate} must be a number for budgetCap`).toBe("number");
    expect(typeof bud, `${toolName}: ${budget} must be a number for budgetCap`).toBe("number");
    // Ceiling = requested budget + tolerance for fixed JSON scaffolding and the
    // #1207 prose-vs-structured charge gap. Uncounted CONTENT (the #1199 events
    // regression) overshoots this; a healthy connector payload does not.
    const ceiling = Math.ceil(bud * (1 + tolerance));
    expect(
      est <= ceiling,
      `${toolName}: ${estimate} (=${est}) must be <= ${budget} (=${bud}) + ${Math.round(tolerance * 100)}% scaffolding tolerance (=${ceiling}) — payload must respect the requested budget (#1199 events blowout)`,
    ).toBe(true);
  }

  // flair#1290 step 4 — the #1270 token-ledger identity, enforced at every
  // conform() site: total ≈ Σ terms, bounded on both sides. Constants and
  // reasoning live in the contract declaration (ToolInvariants.tokenDecomposition,
  // resources/mcp-tools.ts) — one identity, one tolerance definition; the
  // ledger suite (bootstrap-token-ledger-1270.test.ts) reads the same ones.
  if (inv.tokenDecomposition) {
    const d = inv.tokenDecomposition;
    const total = result?.[d.total];
    expect(typeof total, `${toolName}: ${d.total} must be a number for tokenDecomposition`).toBe("number");
    let termSum = 0;
    for (const term of d.terms) {
      const v = result?.[term];
      expect(
        typeof v,
        `${toolName}: ledger term '${term}' must be a number — the counter convention reports 0, never omits (#1270)`,
      ).toBe("number");
      termSum += v;
    }
    const gap = total - termSum;
    const decomposed = d.terms.map((t) => `${t}=${result?.[t]}`).join(" + ");
    // Lower bound always: a counter reporting content that never shipped runs
    // the sum ABOVE the total past per-line ceil rounding.
    expect(
      gap >= -d.roundingSlack,
      `${toolName}: ledger sum exceeds ${d.total} beyond rounding — ${d.total}(${total}) - (${decomposed}) = ${gap} must be >= -${d.roundingSlack}; a counter is over-reporting (#1270 mirrored)`,
    ).toBe(true);
    // Upper bound: waived only when the request opted into the prose mirror,
    // which legitimately widens the gap by the full prose context. When the
    // contract declares that arg, the driven args are REQUIRED — an
    // unevaluated bound must not look like a pass.
    if (d.proseMirrorArg !== undefined) {
      expect(
        opts.args !== undefined,
        `${toolName}: tokenDecomposition declares proseMirrorArg '${d.proseMirrorArg}' — pass the request args to conform() (an unevaluated check must not look like a pass)`,
      ).toBe(true);
    }
    const proseMirrorOn = d.proseMirrorArg !== undefined && Boolean(opts.args![d.proseMirrorArg]);
    if (!proseMirrorOn) {
      let shippedItems = 0;
      for (const c of d.perItemContainers) {
        const arr = getPath(result, c);
        expect(Array.isArray(arr), `${toolName}: tokenDecomposition per-item container '${c}' must be an array`).toBe(true);
        shippedItems += arr.length;
      }
      const tolerance = d.perItemGap * shippedItems + d.fixedSlack;
      expect(
        gap <= tolerance,
        `${toolName}: token-ledger identity broke — ${d.total}(${total}) - (${decomposed}) = ${gap} must be <= ${tolerance} (${d.perItemGap}/item × ${shippedItems} shipped items + ${d.fixedSlack} fixed): an uncounted content class reopens exactly the #1270 field gap`,
      ).toBe(true);
    }
  }

  for (const { included, truncated, available } of inv.countCoherence ?? []) {
    const inc = result?.[included];
    const tru = result?.[truncated];
    const avail = result?.[available];
    expect(typeof inc, `${toolName}: ${included} must be a number`).toBe("number");
    expect(typeof tru, `${toolName}: ${truncated} must be a number`).toBe("number");
    expect(typeof avail, `${toolName}: ${available} must be a number`).toBe("number");
    expect(
      inc + tru <= avail,
      `${toolName}: ${included}(=${inc}) + ${truncated}(=${tru}) must be <= ${available}(=${avail}) — included and truncated are disjoint subsets of the pool (#1207 over-count)`,
    ).toBe(true);
  }

  // flair#1290 — populated-or-hint: each declared hint is present exactly when
  // its emission condition holds, absent otherwise (#1182's 0.44.11 rule).
  for (const rule of inv.hintWhenEmpty ?? []) {
    const needsArgs = rule.presentWhenStringArgBlank !== undefined || rule.requiresNonEmptyArrayArg !== undefined;
    if (needsArgs) {
      expect(
        opts.args !== undefined,
        `${toolName}: hintWhenEmpty('${rule.hint}') references a request arg — pass the request args to conform() (an unevaluated check must not look like a pass)`,
      ).toBe(true);
    }
    let expected: boolean;
    let why: string;
    if (rule.presentWhenStringArgBlank !== undefined) {
      const v = opts.args![rule.presentWhenStringArgBlank];
      expected = !(typeof v === "string" && v.trim().length > 0);
      why = `request arg '${rule.presentWhenStringArgBlank}' was ${expected ? "absent/blank" : "provided"}`;
    } else {
      const arr = getPath(result, rule.container!);
      expect(Array.isArray(arr), `${toolName}: hintWhenEmpty('${rule.hint}') container '${rule.container}' must be an array`).toBe(true);
      expected = arr.length === 0;
      why = `container '${rule.container}' ${expected ? "shipped empty" : `holds ${arr.length}`}`;
      if (rule.requiresNonEmptyArrayArg !== undefined) {
        const a = opts.args![rule.requiresNonEmptyArrayArg];
        const asked = Array.isArray(a) && a.length > 0;
        expected = expected && asked;
        why += `; arg '${rule.requiresNonEmptyArrayArg}' ${asked ? "was requested" : "was NOT requested"}`;
      }
    }
    const hintVal = result?.[rule.hint];
    if (expected) {
      expect(
        typeof hintVal === "string" && hintVal.length > 0,
        `${toolName}: '${rule.hint}' must be a non-empty string — ${why}, so the empty state must say why (#1182 populated-or-hint; got ${JSON.stringify(hintVal)})`,
      ).toBe(true);
    } else {
      expect(
        has(result, rule.hint),
        `${toolName}: '${rule.hint}' must be ABSENT — ${why}, so no hint is due (a hint beside a populated container is as wrong as a missing one)`,
      ).toBe(false);
    }
  }

  // flair#1290 — no event the wrapper's own classifier flags as a zero-row
  // no-op ships in the container (#1200 render filter, asserted semantically).
  if (inv.noOpEventsSuppressed) {
    const arr = getPath(result, inv.noOpEventsSuppressed.container) ?? [];
    // (a) Classifier over each DELIVERED element — bites when events carry
    // `detail` (includeEventDetail:true); lean events carry no `detail`, so
    // this leg alone cannot fire at the /mcp default — hence leg (b).
    for (const ev of arr) {
      expect(
        isZeroRowNoOpEvent(ev),
        `${toolName}: delivered ${inv.noOpEventsSuppressed.container}[] entry (id=${ev?.id}) classifies as a zero-row no-op — the #1200 render filter let it through`,
      ).toBe(false);
    }
    // (b) Classifier over the RAW seeded rows: no row IT classifies as a
    // no-op may have been delivered. Keyed by id, so it fires on the lean
    // path too. The call site holds the positive control (the seeds must
    // contain rows the classifier actually flags).
    if (opts.seededEvents) {
      const noOpIds = new Set(
        opts.seededEvents.filter((e) => isZeroRowNoOpEvent(e as any)).map((e: any) => e.id),
      );
      for (const ev of arr) {
        expect(
          noOpIds.has(ev?.id),
          `${toolName}: ${inv.noOpEventsSuppressed.container}[] delivered a seeded row (id=${ev?.id}) the classifier marks as a zero-row no-op`,
        ).toBe(false);
      }
    }
  }

  if (inv.proseContextIsPointerAtDefault) {
    const ctx = result?.[inv.proseContextIsPointerAtDefault.field] ?? "";
    expect(typeof ctx, `${toolName}: prose context must be a string`).toBe("string");
    for (const ev of result?.events ?? []) {
      if (ev?.summary) {
        expect(ctx.includes(ev.summary), `${toolName}: prose context must not re-carry an event body at the /mcp default (#1199)`).toBe(false);
      }
    }
    for (const m of result?.memories ?? []) {
      if (m?.content) {
        expect(ctx.includes(m.content), `${toolName}: prose context must not re-carry a memory body at the /mcp default (#1199)`).toBe(false);
      }
    }
  }

  for (const rule of inv.containerRules ?? []) {
    const arr = getPath(result, rule.container);
    if (!Array.isArray(arr)) continue;
    for (const el of arr) {
      for (const f of rule.requiredFields ?? []) {
        expect(el?.[f], `${toolName}: ${rule.container}[].${f} required`).not.toBeUndefined();
      }
      for (const f of rule.forbiddenFields ?? []) {
        expect(has(el, f), `${toolName}: ${rule.container}[] leaked internal field '${f}'`).toBe(false);
      }
    }
  }
}
