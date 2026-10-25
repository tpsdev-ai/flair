/**
 * True when `auth` is the `internal` verdict, `context` carries the
 * `__flairInternal` marker (which `internalContext()` sets), and
 * `context.request ?? context` has no `headers`.
 *
 * Called by allowAdmin (resources/agent-auth.ts), soulWriteSource
 * (resources/soul-write-policy.ts) and skillWriteSource
 * (resources/skill-write-policy.ts).
 */
export function isDeliberateInternalVerdict(context: any, auth: { kind: string }): boolean {
  const request = context?.request ?? context;
  return auth.kind === "internal" && context?.__flairInternal === true && !request?.headers;
}
