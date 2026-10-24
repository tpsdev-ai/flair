/**
 * The ONE rule for admitting the trusted `internal` verdict to an elevated gate:
 * the context carries `internalContext()`'s marker and no request headers. A
 * context that resolved to `internal` by being omitted is refused.
 *
 * Shared by the admin-only gate (resources/agent-auth.ts) and the Soul/AgentSeed
 * and skill-write source classification, so those three cannot drift apart.
 */
export function isDeliberateInternalVerdict(context: any, auth: { kind: string }): boolean {
  const request = context?.request ?? context;
  return auth.kind === "internal" && context?.__flairInternal === true && !request?.headers;
}
