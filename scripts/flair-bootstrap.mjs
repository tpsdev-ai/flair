#!/usr/bin/env node
/**
 * Flair bootstrap — agent cold start from Flair.
 * Pulls identity (soul), recent memories, and semantically relevant context.
 *
 * Usage:
 *   node flair-bootstrap.mjs                          # Full bootstrap
 *   node flair-bootstrap.mjs --soul-only              # Just identity
 *   node flair-bootstrap.mjs --days 3                 # Last N days
 *   node flair-bootstrap.mjs --query "Harper sandbox"  # Semantic context
 */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const { subtle } = webcrypto;

const FLAIR_URL = process.env.FLAIR_URL || 'http://127.0.0.1:9926';
const AGENT_ID = process.env.FLAIR_AGENT_ID || 'flint';
const PRIV_KEY_PATH = process.env.FLAIR_PRIV_KEY || `${process.env.HOME}/.tps/secrets/flair/${AGENT_ID}-priv.key`;

async function loadPrivateKey() {
  const b64 = readFileSync(PRIV_KEY_PATH, 'utf8').trim();
  return subtle.importKey('pkcs8', Buffer.from(b64, 'base64'), { name: 'Ed25519' }, false, ['sign']);
}

async function flairFetch(method, path, privKey, body = null) {
  const ts = Date.now().toString();
  const nonce = webcrypto.randomUUID();
  const payload = `${AGENT_ID}:${ts}:${nonce}:${method}:${path}`;
  const sig = await subtle.sign('Ed25519', privKey, new TextEncoder().encode(payload));
  const headers = {
    'Authorization': `TPS-Ed25519 ${AGENT_ID}:${ts}:${nonce}:${Buffer.from(sig).toString('base64')}`,
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${FLAIR_URL}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) return null;
  return res.json();
}

const args = process.argv.slice(2);
const soulOnly = args.includes('--soul-only');
const daysIdx = args.indexOf('--days');
const days = daysIdx > -1 ? parseInt(args[daysIdx + 1]) : 3;
const queryIdx = args.indexOf('--query');
const query = queryIdx > -1 ? args.slice(queryIdx + 1).join(' ') : null;
const json = args.includes('--json');

try {
  const privKey = await loadPrivateKey();

  // === Soul / Identity ===
  const souls = await flairFetch('GET', `/Soul/?agentId=${AGENT_ID}`, privKey);
  if (souls?.length) {
    if (json) {
      console.log(JSON.stringify({ type: 'soul', entries: souls }));
    } else {
      console.log('# Identity (from Flair)\n');
      for (const s of souls) {
        console.log(`## ${s.key}`);
        console.log(s.value);
        console.log('');
      }
    }
  }

  if (soulOnly) process.exit(0);

  // === Semantic search (if query provided) ===
  if (query) {
    const results = await flairFetch('POST', '/MemorySearch/', privKey, {
      agentId: AGENT_ID, q: query, limit: 5,
    });
    if (results?.results?.length) {
      if (json) {
        console.log(JSON.stringify({ type: 'search', query, results: results.results }));
      } else {
        console.log(`\n# Relevant Context: "${query}"\n`);
        for (const r of results.results) {
          const date = r.createdAt?.slice(0, 10) || '?';
          const content = r.content?.length > 1500 ? r.content.slice(0, 1500) + '\n...(truncated)' : r.content;
          console.log(`## ${date} [score: ${r._score}]`);
          console.log(content);
          console.log('');
        }
      }
    }
  }

  // === Recent memories ===
  const memories = await flairFetch('GET', `/Memory/?agentId=${AGENT_ID}`, privKey);
  if (memories?.length) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const recent = memories
      .filter(m => new Date(m.createdAt) >= cutoff)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Also get permanent memories (always relevant)
    const permanent = memories.filter(m => m.durability === 'permanent');

    if (json) {
      console.log(JSON.stringify({ type: 'memories', recent: recent.length, permanent: permanent.length, total: memories.length }));
    } else {
      if (permanent.length) {
        console.log('\n# Permanent Memories\n');
        for (const m of permanent) {
          console.log(`## ${m.id}`);
          const content = m.content?.length > 1000 ? m.content.slice(0, 1000) + '\n...(truncated)' : m.content;
          console.log(content);
          console.log('');
        }
      }

      if (recent.length) {
        console.log(`\n# Recent Memories (last ${days} days)\n`);
        for (const m of recent) {
          const date = m.createdAt?.slice(0, 10) || 'unknown';
          const content = m.content?.length > 2000 ? m.content.slice(0, 2000) + '\n...(truncated)' : m.content;
          console.log(`## ${date} — ${m.source || m.id}`);
          console.log(content);
          console.log('');
        }
      }

      // Stats
      const withEmbed = memories.filter(m => m.embedding?.length > 100).length;
      console.log(`\n---`);
      console.log(`Flair: ${memories.length} memories | ${permanent.length} permanent | ${withEmbed} with embeddings | search: ${query ? 'yes' : 'available'}`);
    }
  }
} catch (err) {
  if (json) {
    console.log(JSON.stringify({ type: 'error', error: err.message }));
  } else {
    console.error(`Flair unavailable: ${err.message}`);
    console.error('Falling back to flat files.');
  }
  process.exit(1);
}
