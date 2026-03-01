#!/usr/bin/env node
/**
 * Flair bootstrap — read agent identity + recent memories from Flair.
 * Outputs markdown suitable for injecting into agent context.
 *
 * Usage:
 *   node flair-bootstrap.mjs              # Full bootstrap (soul + recent memories)
 *   node flair-bootstrap.mjs --soul-only  # Just soul/identity
 *   node flair-bootstrap.mjs --days 3     # Last N days of memories
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

async function flairFetch(method, path, privKey) {
  const ts = Date.now().toString();
  const nonce = webcrypto.randomUUID();
  const payload = `${AGENT_ID}:${ts}:${nonce}:${method}:${path}`;
  const sig = await subtle.sign('Ed25519', privKey, new TextEncoder().encode(payload));
  const res = await fetch(`${FLAIR_URL}${path}`, {
    method,
    headers: {
      'Authorization': `TPS-Ed25519 ${AGENT_ID}:${ts}:${nonce}:${Buffer.from(sig).toString('base64')}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

const args = process.argv.slice(2);
const soulOnly = args.includes('--soul-only');
const daysIdx = args.indexOf('--days');
const days = daysIdx > -1 ? parseInt(args[daysIdx + 1]) : 3;

try {
  const privKey = await loadPrivateKey();

  // Get soul entries
  const souls = await flairFetch('GET', `/Soul/?agentId=${AGENT_ID}`, privKey);
  if (souls?.length) {
    console.log('# Soul (from Flair)');
    for (const s of souls) {
      console.log(`\n## ${s.key}`);
      console.log(s.value);
    }
  }

  if (soulOnly) process.exit(0);

  // Get recent memories
  const memories = await flairFetch('GET', `/Memory/?agentId=${AGENT_ID}`, privKey);
  if (memories?.length) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const recent = memories
      .filter(m => new Date(m.createdAt) >= cutoff)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    if (recent.length) {
      console.log(`\n# Recent Memories (last ${days} days)`);
      for (const m of recent) {
        const date = m.createdAt?.slice(0, 10) || 'unknown';
        const dur = m.durability || 'standard';
        console.log(`\n## ${date} [${dur}]`);
        // Truncate long entries
        const content = m.content.length > 2000 ? m.content.slice(0, 2000) + '\n...(truncated)' : m.content;
        console.log(content);
      }
    }

    // Stats
    const permanent = memories.filter(m => m.durability === 'permanent').length;
    const persistent = memories.filter(m => m.durability === 'persistent').length;
    const standard = memories.filter(m => m.durability === 'standard').length;
    console.log(`\n---`);
    console.log(`Flair: ${memories.length} memories (${permanent} permanent, ${persistent} persistent, ${standard} standard)`);
  }
} catch (err) {
  console.error(`Flair unavailable: ${err.message}`);
  console.error('Falling back to flat files.');
  process.exit(1);
}
