/**
 * ─── The in-process call seam (one incantation, one place) ───────────────────
 *
 * How code running INSIDE the Harper process invokes a flair resource AS a
 * specific agent — flair's own native MCP handler (resources/mcp-tools.ts), and
 * any co-located application component that loads flair as a sub-component and
 * calls it directly instead of over HTTP.
 *
 * Three things an in-process caller has to get right, none of which is visible
 * from a resource's own source and none of which used to fail in a way that
 * points at the cause:
 *
 * 1. **Identity.** Every flair resource resolves its caller through
 *    resources/agent-auth.ts's `resolveAgentAuth()`, whose FIRST hop is the
 *    `tpsAgent` annotation the HTTP auth middleware stamps on a verified
 *    request. There is no HTTP request in-process, so the caller supplies that
 *    annotation itself — {@link agentContext}.
 *
 * 2. **Not accidentally becoming an administrator.** A context with no usable
 *    agent id resolves to flair's trusted `internal` verdict, which is
 *    UNFILTERED. See the safety-design block below: this module's API shape is
 *    built around making that unreachable by accident.
 *
 * 3. **Collection binding.** A resource's `post()` — the create path — only
 *    works on a resource instance Harper has marked as a COLLECTION. That mark
 *    is a PRIVATE field (`#isCollection`) set inside Harper's own
 *    `getResource()`; the public `isCollection` is a GETTER WITH NO SETTER on
 *    `Resource.prototype`. So the obvious `new Cls(undefined, ctx)` +
 *    `h.isCollection = true` does not "not work" quietly — under ESM (always
 *    strict mode) the assignment throws
 *    `TypeError: Cannot set property isCollection ... which has only a getter`,
 *    and dropping the assignment instead yields
 *    `405 The <X> does not have a post method implemented` from Harper's base
 *    `Resource.post()`. {@link collectionResource} is the one supported way in:
 *    hand `getResource()` an `{ isCollection: true }` option and let Harper set
 *    its own private field.
 *
 * flair itself got (3) wrong in four MCP tool paths before this module existed —
 * the same mistake a consumer reading only the resource classes would make.
 *
 * ─── SAFETY DESIGN: the dangerous thing has to look dangerous ────────────────
 *
 * MEASURED, against the real resolver:
 *
 *   resolveAgentAuth({ request: { tpsAgent: undefined } })  ->  { kind: "internal" }
 *   resolveAgentAuth({ request: { tpsAgent: ""        } })  ->  { kind: "internal" }
 *   allowAdmin({ request: { tpsAgent: undefined } })        ->  true
 *
 * `resolveAgentAuth` tests `tpsAgent` for TRUTHINESS, so a missing or empty id
 * is indistinguishable from "no identity was supplied at all" — and that is the
 * trusted verdict. The consequence is that the most ordinary application bug
 * there is — `agentContext(session.agentId)` where the field is undefined, a
 * typo'd property, a lookup that found nothing — would not fail closed. It
 * would silently grant unfiltered cross-agent reads and writes, and pass the
 * admin-only gate on admin-only resources. No error, no 403, no log line.
 *
 * That is the same defect class as a check that cannot fail: **the failure mode
 * of "I forgot the id" must never be "you are now an administrator."** So:
 *
 *   - {@link agentContext} THROWS on a missing, empty or blank id. It is always
 *     a programming error, and an exception is the only outcome that cannot be
 *     mistaken for success.
 *   - {@link agentContext} takes NO options. It is structurally incapable of
 *     producing an admin context, so spreading a caller-influenced object into
 *     its arguments cannot escalate.
 *   - Admin is a SEPARATE, NAMED export ({@link adminContext}), and so is the
 *     unfiltered maintenance verdict ({@link internalContext}). Both are
 *     greppable: `git grep -n "adminContext\|internalContext"` enumerates every
 *     privileged call site in a codebase.
 *   - {@link collectionResource} REQUIRES a context and throws without one, so
 *     the privileged path can never be reached by leaving an argument off. The
 *     dangerous path is now the LONGEST path, not the shortest.
 *
 * These guards are runtime, not types, on purpose: an embedding application may
 * be plain JavaScript, where a `string` parameter annotation buys exactly
 * nothing. test/integration/in-process-agents.test.ts pins both the guards and
 * the hazard they exist for, against a real Harper.
 *
 * ── Deliberately dependency-free ─────────────────────────────────────────────
 * No `import { databases } from "harper"` (see resources/memory-visibility.ts
 * for why that import is load-bearing to avoid): these helpers are pure shape,
 * and an embedding app may want them before any table is resolved.
 */

/** The context shape flair resources resolve a caller's identity from. */
export interface CallContext {
  request: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Thrown when an in-process call is built in a way that would have silently
 * escalated. Its own type so a caller can distinguish "I wired this wrong" from
 * a resource's business-logic refusal (which arrives as a `Response`, not a
 * throw).
 */
export class InProcessContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InProcessContextError";
  }
}

/** Reject anything that would resolve to the trusted `internal` verdict, or to a nonsense id. */
function requireAgentId(agentId: unknown, fnName: string): string {
  if (typeof agentId !== "string" || agentId.trim() === "") {
    const got =
      agentId === undefined ? "undefined"
      : agentId === null ? "null"
      : typeof agentId !== "string" ? `a ${typeof agentId}`
      : agentId === "" ? "an empty string"
      : "a blank string";
    throw new InProcessContextError(
      `${fnName}() requires a non-empty agent id, but received ${got}. ` +
      "This is refused rather than defaulted because flair resolves a missing or empty " +
      "tpsAgent to its trusted `internal` verdict, which reads and writes UNFILTERED across " +
      "every agent and passes the admin-only gate — so returning a context here would have " +
      "turned a missing id into silent administrator access. Resolve the agent id from your " +
      "own server-side state before calling, and never from request data.",
    );
  }
  return agentId;
}

/**
 * The resource context that makes an in-process call act as ONE SPECIFIC agent.
 * This is the call an application makes; the other two constructors below are
 * privileged and deliberately harder to type.
 *
 * **`agentId` is asserted, not proven.** flair reads it and acts as that agent:
 * no signature, no lookup against the `Agent` table, no registration
 * requirement. That is right for a caller already inside the trust boundary —
 * it could write the raw table anyway — and it is exactly why the id must come
 * from YOUR OWN server-side state (the session you authenticated, the job
 * record you dequeued) and **never from request data**. An agent id that
 * reaches here from a body field, a query param, or a header you did not verify
 * yourself is privilege escalation with no error and no trace.
 *
 * Throws {@link InProcessContextError} on a missing, empty or blank id — see the
 * safety-design block at the top of this file for why that is not merely
 * defensive.
 *
 * Takes no options, and in particular no way to ask for admin: use
 * {@link adminContext} for that, so the escalation is a word you had to type.
 *
 * ```ts
 * const Memory = server.resources.get("Memory").Resource;
 * const h = await collectionResource(Memory, agentContext("planner"));
 * const { id } = await h.post({ agentId: "planner", content: "…" });
 * ```
 */
export function agentContext(agentId: string): CallContext {
  return {
    request: {
      tpsAgent: requireAgentId(agentId, "agentContext"),
      tpsAgentIsAdmin: false,
    },
  };
}

/**
 * Like {@link agentContext}, but with flair-admin authority: unfiltered
 * cross-agent reads, and writes attributed to agents other than this one.
 *
 * Asserted, never checked — nothing validates that the named agent is actually
 * an admin principal. **Treat a call to this exactly as you would a root
 * shell:** provisioning and maintenance only, never a request handler's
 * default, and never with an id or a flag derived from anything a caller
 * supplied.
 *
 * It is a separate export rather than an option so that (a) no options object
 * spread into {@link agentContext} can escalate, and (b) every privileged call
 * site in a codebase is findable by name.
 *
 * Throws {@link InProcessContextError} on a missing, empty or blank id.
 */
export function adminContext(agentId: string): CallContext {
  return {
    request: {
      tpsAgent: requireAgentId(agentId, "adminContext"),
      tpsAgentIsAdmin: true,
    },
  };
}

/**
 * The TRUSTED, UNATTRIBUTED, UNFILTERED context — flair's `internal` verdict.
 * Reads see every agent's private records; writes are owned by nobody.
 *
 * This exists for work that is genuinely infrastructure rather than an agent's:
 * provisioning a principal, a migration, a maintenance sweep. It is the same
 * verdict a context-less call used to fall into by accident; naming it means an
 * application can no longer reach it by forgetting an argument, and means
 * `git grep internalContext` enumerates every place flair or an embedder took
 * that authority deliberately.
 *
 * There is no id to validate: the verdict comes precisely from the ABSENCE of
 * an identity annotation, so the returned object carries none. The marker field
 * is inert — it documents intent at a debugger breakpoint and is read by
 * nothing.
 *
 * ```ts
 * // Registering a principal — infrastructure, not an agent's own write.
 * const h = await collectionResource(Agent, internalContext());
 * await h.post({ id, name: id, publicKey });
 * ```
 */
export function internalContext(): CallContext {
  return { request: {}, __flairInternal: true };
}

/**
 * A resource instance bound to `context` and marked as a COLLECTION, so its
 * `post()` (the create path) works — see this module's header for why that mark
 * cannot be applied from outside Harper.
 *
 * `context` is REQUIRED. Passing nothing used to yield the unfiltered
 * `internal` verdict, which made the privileged path the shortest one to type;
 * it now throws. Pass {@link agentContext} for an agent's own work,
 * {@link adminContext} or {@link internalContext} when the authority is
 * genuinely intended.
 *
 * Reads do not need this — `Cls.get(id, context)` and `Cls.search(query,
 * context)` (Harper's static resource methods) already thread the context and
 * start their own transaction.
 */
export async function collectionResource<T = any>(Cls: any, context: CallContext): Promise<T> {
  if (context == null || typeof context !== "object") {
    throw new InProcessContextError(
      "collectionResource() requires an explicit context, but received " +
      (context === undefined ? "undefined" : context === null ? "null" : `a ${typeof context}`) +
      ". Omitting it would resolve to flair's trusted `internal` verdict — unfiltered reads and " +
      "unattributed writes across every agent — so the privileged path is never the one you get " +
      "by leaving an argument off. Pass agentContext(id) to act as an agent, or internalContext() " +
      "if this really is infrastructure work.",
    );
  }
  // `{}` is a sufficient RequestTarget here: getResource() reads only `.id` off
  // it (undefined ⇒ Harper mints the primary key), and takes the collection
  // mark from the options argument.
  return (await Cls.getResource({}, context, { isCollection: true })) as T;
}
