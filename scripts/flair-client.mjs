#!/usr/bin/env node
/**
 * Flair CLI client with Ed25519 TPS auth.
 * All embeddings are handled server-side (in-process in Harper).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { webcrypto } from 'node:crypto';
const { subtle } = webcrypto;

const FLAIR_URL = process.env.FLAIR_URL || 'http://127.0.0.1:9926';
// The signing identity. `FLAIR_AGENT_ID` or `--agent <id>` is explicit; a shipped
// default is a trust anchor by omission (flair#1816), and a read is as much a
// signed request as a write (flair#1851): an identity-less `search`/`get`/`list`
// signed as whoever the default named and returned that principal's non-shared
// records to a caller who never chose it. EVERY action this script supports goes
// through flairFetch, which always sets an Authorization header, so every action
// refuses without an explicit identity — resolved in the argv section below once
// the action is known. There is no genuinely-unsigned action here; if one is ever
// added (one that sends no Authorization header) it may run identity-less, so
// exempt it from this set and test that it sends no header.
const SIGNING_ACTIONS = new Set(['list', 'get', 'write', 'set', 'delete', 'search']);
let AGENT_ID;

// RFC 8410 PKCS8 prefix for an Ed25519 private key carrying a bare 32-byte seed.
// `flair agent add` writes that bare seed; wrapping it here means no operator ever
// has to hand-construct this DER again (flair#1736).
const PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Candidate private-key files for `agentId`, in probe order (flair#1736).
 *
 * `flair agent add` writes a raw 32-byte seed to ~/.flair/keys/<agent>.key; the
 * legacy TPS layout is ~/.tps/secrets/flair/<agent>-priv.key (base64 PKCS8).
 * FLAIR_PRIV_KEY is an explicit override and wins outright. The order mirrors the
 * CLI's own resolveKeyPath() so the script and the CLI agree on where to look.
 */
function keyPathCandidates(agentId) {
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
function resolveKeyPath(agentId) {
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
async function loadPrivateKeyFromFile(path) {
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

async function loadPrivateKey() {
  const path = resolveKeyPath(AGENT_ID);
  if (!path) {
    throw new Error(
      `no private key found for agent '${AGENT_ID}'. Looked in:\n  ` +
        keyPathCandidates(AGENT_ID).join('\n  ') +
        `\nRegister one with 'flair agent add ${AGENT_ID}', or point FLAIR_PRIV_KEY at its path.`,
    );
  }
  return loadPrivateKeyFromFile(path);
}

async function flairFetch(method, path, body = null) {
  const privKey = await loadPrivateKey();
  const ts = Date.now().toString();
  const nonce = webcrypto.randomUUID();
  const payload = `${AGENT_ID}:${ts}:${nonce}:${method}:${path}`;
  const sig = await subtle.sign('Ed25519', privKey, new TextEncoder().encode(payload));
  const headers = { 'Authorization': `TPS-Ed25519 ${AGENT_ID}:${ts}:${nonce}:${Buffer.from(sig).toString('base64')}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${FLAIR_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

const [,, resource, action, ...rest] = process.argv;
if (!resource || !action) {
  console.error('Usage: flair-client.mjs <memory|soul|agent> <list|get|write|set|delete|search> [--agent <id>] [args]');
  console.error('Every action signs its request, so every action needs an explicit identity: set FLAIR_AGENT_ID or pass --agent <id>.');
  process.exit(1);
}

// Signing identity (flair#1816, flair#1851): FLAIR_AGENT_ID wins, then an
// explicit `--agent <id>`. Any SIGNING action without either refuses instead of
// defaulting — the old shipped default signed every forgotten caller as 'flint',
// and ownership-scoped operations then bound to an identity nobody chose. Reads
// were no exception: the same default made an identity-less `search`/`get`/`list`
// return that principal's records to a caller who never chose them.
const agentFlagIndex = rest.indexOf('--agent');
const agentFromFlag = agentFlagIndex === -1 ? undefined : rest[agentFlagIndex + 1];
if (agentFlagIndex !== -1) {
  if (agentFromFlag === undefined || agentFromFlag === '' || agentFromFlag.startsWith('--')) {
    console.error('--agent requires a value');
    process.exit(1);
  }
  rest.splice(agentFlagIndex, 2);
  // One removal is not a loop: a second `--agent` would survive into the
  // positional join and land in the written content — the same flag-folding
  // class extractFlags exists to prevent. Refuse instead (flair#1816 review).
  if (rest.includes('--agent')) {
    console.error('--agent may only be given once');
    process.exit(1);
  }
}
if (SIGNING_ACTIONS.has(action) && !process.env.FLAIR_AGENT_ID && !agentFromFlag) {
  console.error(
    `refusing to ${action}: no agent identity. Set FLAIR_AGENT_ID or pass --agent <id>. ` +
      `A default identity would sign as a principal the caller did not choose (flair#1816).`,
  );
  process.exit(1);
}
AGENT_ID = process.env.FLAIR_AGENT_ID || agentFromFlag;

const table = resource.charAt(0).toUpperCase() + resource.slice(1);

// Every flag this script understands, in any command. Used to catch a flag passed to a
// command that does not take it — which is the bug this whole helper exists to prevent:
// `search "q" --limit 20` used to fold the unparsed flag into the query and search for the
// literal text "q --limit 20".
const KNOWN_FLAGS = new Set(['--durability', '--supersedes', '--used', '--limit']);

/**
 * Split `args` into `--flag value` pairs and free text.
 *
 * A flag with no value is a HARD ERROR rather than being folded into the free text.
 * Silently folding it in is precisely the defect this replaced: the argument stops being
 * an instruction and becomes content, and the caller gets a plausible wrong answer instead
 * of a refusal. A flag that belongs to a different command errors for the same reason.
 */
function extractFlags(args, wanted) {
  const values = Object.create(null);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (wanted.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v === '' || KNOWN_FLAGS.has(v)) {
        console.error(`${a} requires a value`);
        process.exit(1);
      }
      values[a] = v;
      i++;
    } else if (KNOWN_FLAGS.has(a)) {
      console.error(`${a} is not a valid flag for '${action}' (accepts: ${wanted.join(', ') || 'none'})`);
      process.exit(1);
    } else {
      positional.push(a);
    }
  }
  return { values, positional };
}

try {
  let result;
  switch (action) {
    case 'list':
      result = await flairFetch('GET', `/${table}/?agentId=${AGENT_ID}`);
      break;
    case 'get':
      result = await flairFetch('GET', `/${table}/${rest[0]}`);
      break;
    case 'write': {
      // Support --durability <level>, --supersedes <id>, and --used <csv> flags
      const { values, positional } = extractFlags(rest, ['--durability', '--supersedes', '--used']);
      const durability = values['--durability'] ?? 'standard';
      const supersedes = values['--supersedes'];
      const usedMemoryIds = values['--used']
        ? values['--used'].split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const content = positional.join(' ');
      const id = `${AGENT_ID}-${Date.now()}`;
      const body = { id, agentId: AGENT_ID, content, durability, createdAt: new Date().toISOString() };
      if (supersedes) body.supersedes = supersedes;
      // flair#744 slice A: citation-on-write — only set when --used was
      // given, so omitting the flag is byte-identical to before.
      if (usedMemoryIds) body.usedMemoryIds = usedMemoryIds;
      result = await flairFetch('PUT', `/${table}/${id}`, body);
      break;
    }
    case 'set': {
      const [key, ...v] = rest;
      result = await flairFetch('PUT', `/${table}/${AGENT_ID}-${key}`, {
        id: `${AGENT_ID}-${key}`, agentId: AGENT_ID, key, value: v.join(' '),
        durability: 'permanent', createdAt: new Date().toISOString(),
      });
      break;
    }
    case 'delete':
      result = await flairFetch('DELETE', `/${table}/${rest[0]}`);
      break;
    case 'search': {
      // Support --limit <n>. It was previously neither parsed nor passed: the flag and its
      // value fell through into rest.join(' '), so `search "foo" --limit 20` searched for the
      // literal string "foo --limit 20" and always returned the hardcoded 5 results.
      const { values, positional } = extractFlags(rest, ['--limit']);
      let limit = 5;
      if (values['--limit'] !== undefined) {
        const n = Number(values['--limit']);
        if (!Number.isFinite(n) || n < 1) {
          console.error(`--limit must be a positive number, got: ${values['--limit']}`);
          process.exit(1);
        }
        limit = Math.floor(n);
      }
      const query = positional.join(' ');
      // Server generates query embedding in-process — no sidecar needed
      result = await flairFetch('POST', '/SemanticSearch', { agentId: AGENT_ID, q: query, limit });
      if (result.results) {
        for (const r of result.results) {
          const date = r.createdAt?.slice(0, 10) || '?';
          const snippet = (r.content || '').replace(/\n/g, ' ').slice(0, 120);
          console.log(`[${r._score}] ${date} ${r.id}: ${snippet}`);
        }
        console.log(`\n${result.results.length} results`);
        process.exit(0);
      }
      break;
    }
    default:
      console.error(`Unknown action: ${action}`);
      process.exit(1);
  }
  if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
