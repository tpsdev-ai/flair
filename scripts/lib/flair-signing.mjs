// Shared Ed25519 request signing for the Flair scripts (flair#1855).
//
// Extracted from scripts/flair-client.mjs so the key-resolution order and the
// signing path have ONE definition. A script that hand-rolls its own signedFetch
// drifts from the client's, and — as flair#1855 found — can sign as an identity
// the caller never chose (scripts/repro-resource-busy.mjs signed as a hardcoded
// 'flint'). Only `node:` builtins: these run from a plain checkout, no bundler.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { webcrypto } from 'node:crypto';
const { subtle } = webcrypto;

// RFC 8410 PKCS8 prefix for an Ed25519 private key carrying a bare 32-byte seed.
// `flair agent add` writes that bare seed; wrapping it here means no operator ever
// has to hand-construct this DER again (flair#1736).
export const PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Candidate private-key files for `agentId`, in probe order (flair#1736).
 *
 * `flair agent add` writes a raw 32-byte seed to ~/.flair/keys/<agent>.key; the
 * legacy TPS layout is ~/.tps/secrets/flair/<agent>-priv.key (base64 PKCS8).
 * FLAIR_PRIV_KEY is an explicit override and wins outright. The order mirrors the
 * CLI's own resolveKeyPath() so the scripts and the CLI agree on where to look.
 */
export function keyPathCandidates(agentId) {
  if (process.env.FLAIR_PRIV_KEY) return [process.env.FLAIR_PRIV_KEY];
  const homes = [...new Set([homedir(), process.env.HOME].filter(Boolean))];
  const out = [];
  if (process.env.FLAIR_KEY_DIR) out.push(join(process.env.FLAIR_KEY_DIR, `${agentId}.key`));
  for (const home of homes) {
    out.push(join(home, '.flair', 'keys', `${agentId}.key`));
    out.push(join(home, '.tps', 'secrets', 'flair', `${agentId}-priv.key`));
  }
  return out;
}

/** First candidate that exists, or null. */
export function resolveKeyPath(agentId) {
  return keyPathCandidates(agentId).find((p) => existsSync(p)) ?? null;
}

/**
 * Load an Ed25519 signing key from `path`, accepting every shape Flair writes:
 *   - a raw 32-byte seed (what `flair agent add` writes to ~/.flair/keys/*.key)
 *   - base64 of that raw seed
 *   - base64 PKCS8 DER (the legacy ~/.tps/secrets/flair/*-priv.key shape)
 *
 * A bare seed is wrapped in the fixed PKCS8 prefix above. Anything unrecognised
 * throws an error that names the ENCODING problem (path + byte length), never the
 * key bytes — so a malformed key cannot masquerade as an authentication failure.
 */
export async function loadPrivateKeyFromFile(path) {
  const raw = readFileSync(path);
  const asPkcs8 = (der) => subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  try {
    if (raw.length === 32) return await asPkcs8(Buffer.concat([PKCS8_SEED_PREFIX, raw]));
    const decoded = Buffer.from(raw.toString('utf8').trim(), 'base64');
    if (decoded.length === 32) return await asPkcs8(Buffer.concat([PKCS8_SEED_PREFIX, decoded]));
    if (decoded.length > 0) return await asPkcs8(decoded);
    throw new Error('no bytes after base64 decode');
  } catch (err) {
    throw new Error(
      `cannot load private key at ${path} (${raw.length} bytes): not a recognised Ed25519 key encoding. ` +
        `Expected a raw 32-byte seed (what 'flair agent add' writes) or base64/DER PKCS8. ` +
        `This is a key ENCODING problem, not an authentication failure. (${err.message})`,
    );
  }
}

/**
 * Load the signing key for `agentId` from the first existing candidate path.
 * Throws a message that names the agent and every path probed, never the key.
 */
export async function loadPrivateKey(agentId) {
  const path = resolveKeyPath(agentId);
  if (!path) {
    throw new Error(
      `no private key found for agent '${agentId}'. Looked in:\n  ` +
        keyPathCandidates(agentId).join('\n  ') +
        `\nRegister one with 'flair agent add ${agentId}', or point FLAIR_PRIV_KEY at its path.`,
    );
  }
  return loadPrivateKeyFromFile(path);
}

/**
 * Sign and send ONE request as `agentId`. Always sets an Authorization header —
 * there is no identity-less path through this function, which is what makes every
 * caller need an explicit identity.
 *
 * Returns the parsed body by default. `raw: true` returns the undici Response
 * instead, for callers that need the HTTP status (e.g. a repro proving a crash).
 */
export async function signedFetch({ agentId, url, method, path, body = null, raw = false }) {
  const privKey = await loadPrivateKey(agentId);
  const ts = Date.now().toString();
  const nonce = webcrypto.randomUUID();
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = await subtle.sign('Ed25519', privKey, new TextEncoder().encode(payload));
  const headers = { 'Authorization': `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${Buffer.from(sig).toString('base64')}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (raw) return res;
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
