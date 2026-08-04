/**
 * Pushing `mcp enable`'s staged secrets to the target over the ops API, when the
 * target can actually take them (flair#1094).
 *
 * ── What replaced what ──────────────────────────────────────────────────────
 * The mechanism used to be chosen by HOSTNAME: `selectSecretsMechanism` returned
 * `fabric-env-secrets` for anything ending `.harperfabric.com` and `env-file`
 * otherwise. That is wrong in both directions and was wrong in both directions
 * on the day it was replaced:
 *
 *   - tps.dtrt.harperfabric.com runs Harper 5.1.26 and has NO secrets
 *     operations — measured, `set_secret` answers "Operation 'set_secret' not
 *     found", identical to an operation that does not exist at all — and was
 *     selected for the automated mechanism because of its name.
 *   - a self-hosted Harper 5.2 with the Pro env-secrets component is fully
 *     capable and was sent down the manual Fabric Studio path because its
 *     hostname did not match.
 *
 * A hostname is not a capability. Nor is a version: the write operations and the
 * decryptor that makes a `processEnv` secret reach the process ship separately
 * (core vs Pro). So this asks the target directly.
 *
 * ── What this probe does and does not establish ─────────────────────────────
 * It establishes that the secrets OPERATIONS exist, by asking for the public key
 * we would need anyway. It does NOT establish that the Pro decryptor is active,
 * and no read-only call can — a secret only proves it was decrypted by being
 * present in the process.
 *
 * That check already exists downstream: `enable`'s self-verify step fetches the
 * issuer's OAuth metadata, which is only served when `FLAIR_MCP_OAUTH` reached
 * the process. So a push that lands in `hdb_secret` and is never decrypted shows
 * up as a self-verify failure rather than as silent success — provided the
 * failure names this as a candidate cause, which is why `pushed` is threaded
 * through to the result.
 *
 * ── Failure direction ───────────────────────────────────────────────────────
 * Every uncertain outcome falls back to the staged-file flow. That path works
 * today, on every target, and costs the operator a paste. Pushing a secret at an
 * endpoint that may not exist costs a silent flag-OFF boot, which is the exact
 * failure this automation is meant to remove.
 */
import { sealSecret } from "./secret-envelope.js";

export interface SecretsCapability {
  /** True only when the target answered with a usable public key. */
  available: boolean;
  /** Why, in operator-facing words. Always set, including on success. */
  reason: string;
  publicKeyPem?: string;
}

/** `set_secret`'s delivery tier. `processEnv` is global and cannot be scoped —
 *  which is what `FLAIR_MCP_OAUTH` and the signing key PEM need, since both are
 *  read from `process.env` and never from YAML. */
export const PROCESS_ENV_TIER = "processEnv";

async function opsCall(
  opsUrl: string,
  authHeader: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const res = await fetchImpl(opsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body — keep the text */ }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * Ask the target whether it can take pushed secrets, by requesting the key we
 * would encrypt to. Never throws: an unreachable or unparseable target is a
 * fall-back-and-say-why, not a crash mid-enable.
 */
export async function probeSecretsCapability(
  opsUrl: string,
  authHeader: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SecretsCapability> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let r;
  try {
    r = await opsCall(opsUrl, authHeader, { operation: "get_secrets_public_key" }, fetchImpl);
  } catch (err: any) {
    return { available: false, reason: `could not reach the ops API to ask (${err?.message ?? err}) — using the staged-file flow` };
  }

  // "Operation '<name>' not found" is how Harper answers an operation it does
  // not have, and it is byte-identical to the answer for an invented one. That
  // is the signal for a target older than the env-secrets feature.
  const errText = String(r.json?.error ?? r.text ?? "");
  if (/not found/i.test(errText) && /get_secrets_public_key/.test(errText)) {
    return { available: false, reason: "the target's Harper has no env-secrets operations (needs 5.2 or newer) — using the staged-file flow" };
  }
  if (!r.ok) {
    return { available: false, reason: `the target refused the capability probe (HTTP ${r.status}${errText ? `: ${errText.slice(0, 120)}` : ""}) — using the staged-file flow` };
  }

  const pem = extractPublicKeyPem(r.json);
  if (!pem) {
    // Answered, but not with something we can encrypt to. Undeterminable is
    // treated exactly like unavailable — see the failure-direction note above.
    return { available: false, reason: "the target answered the probe without a usable public key — using the staged-file flow" };
  }
  return { available: true, reason: "target supports env-secrets; pushing over the ops API", publicKeyPem: pem };
}

/** Pull the PEM out of whatever shape the operation returns, without guessing
 *  at a value that is not obviously a key. */
function extractPublicKeyPem(json: any): string | undefined {
  const candidates = [json, json?.public_key, json?.publicKey, json?.key, json?.pem, json?.data?.public_key];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes("BEGIN PUBLIC KEY")) return c;
  }
  return undefined;
}

export interface PushedSecret {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Seal and set each var. Values are encrypted client-side, so plaintext never
 * appears in a request body — and never in this module's return value either:
 * results carry NAMES and outcomes only.
 */
export async function pushSecrets(
  opsUrl: string,
  authHeader: string,
  vars: Record<string, string>,
  publicKeyPem: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ allOk: boolean; results: PushedSecret[] }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const results: PushedSecret[] = [];
  for (const [name, value] of Object.entries(vars)) {
    try {
      const r = await opsCall(
        opsUrl,
        authHeader,
        { operation: "set_secret", name, envelope: sealSecret(value, publicKeyPem), tier: PROCESS_ENV_TIER },
        fetchImpl,
      );
      const err = String(r.json?.error ?? "").slice(0, 140);
      results.push({ name, ok: r.ok, detail: r.ok ? undefined : `HTTP ${r.status}${err ? `: ${err}` : ""}` });
    } catch (err: any) {
      results.push({ name, ok: false, detail: String(err?.message ?? err).slice(0, 140) });
    }
  }
  return { allOk: results.every((x) => x.ok), results };
}
