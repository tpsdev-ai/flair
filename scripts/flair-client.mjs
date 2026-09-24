#!/usr/bin/env node
/**
 * Flair CLI client with Ed25519 TPS auth.
 * All embeddings are handled server-side (in-process in Harper).
 */
import { signedFetch } from './lib/flair-signing.mjs';

const FLAIR_URL = process.env.FLAIR_URL || 'http://127.0.0.1:9926';
// The signing identity. `FLAIR_AGENT_ID` or `--agent <id>` is explicit; a shipped
// default is a trust anchor by omission (flair#1816), and a read is as much a
// signed request as a write (flair#1851): an identity-less `search`/`get`/`list`
// signed as whoever the default named and returned that principal's non-shared
// records to a caller who never chose it. EVERY action this script supports goes
// through flairFetch, which always sets an Authorization header, so every action
// refuses without an explicit identity — resolved in the argv section below once
// the action is known.
//
// DENY BY DEFAULT (flair#1855). The guard is keyed on UNSIGNED, not on a list of
// the actions that sign. The old `SIGNING_ACTIONS` set failed OPEN: a case added
// to the dispatch switch below but forgotten from that set would sign with no
// identity at all. Now the only actions that may run identity-less are the ones
// explicitly listed in UNSIGNED — and it is EMPTY. A genuinely-unsigned action
// (one that sends no Authorization header) belongs here; the enumeration test
// runs every switch case and fails if one is neither unsigned nor refused.
const UNSIGNED = new Set([]);
let AGENT_ID;

// Key resolution and signing live in scripts/lib/flair-signing.mjs, shared with
// the other scripts that sign against a running instance (flair#1855).
async function flairFetch(method, path, body = null) {
  return signedFetch({ agentId: AGENT_ID, url: FLAIR_URL, method, path, body });
}

const [,, resource, action, ...rest] = process.argv;
if (!resource || !action) {
  console.error('Usage: flair-client.mjs <memory|soul|agent> <list|get|write|set|delete|search> [--agent <id>] [args]');
  console.error('Every action signs its request, so every action needs an explicit identity: set FLAIR_AGENT_ID or pass --agent <id>.');
  process.exit(1);
}

// Signing identity (flair#1816, flair#1851, flair#1855): FLAIR_AGENT_ID wins, then
// an explicit `--agent <id>`. Any action NOT in UNSIGNED refuses without either,
// instead of defaulting — the old shipped default signed every forgotten caller
// as 'flint', and ownership-scoped operations then bound to an identity nobody
// chose. Reads were no exception: the same default made an identity-less
// `search`/`get`/`list` return that principal's records to a caller who never
// chose them.
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
if (!UNSIGNED.has(action) && !process.env.FLAIR_AGENT_ID && !agentFromFlag) {
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
