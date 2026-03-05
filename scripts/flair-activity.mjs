#!/usr/bin/env node
/**
 * flair-activity.mjs -- Stream TPS OrgEvents to stdout.
 *
 * Usage:
 *   node flair-activity.mjs [--since <ISO>] [--interval <seconds>] [--agent <id>]
 *
 * Options:
 *   --since <ISO>       Start time (default: 1 hour ago)
 *   --interval <sec>    Poll interval in seconds (default: 10)
 *   --agent <id>        Agent id for auth (default: anvil)
 *   --key <path>        Path to Ed25519 private key
 *   --flair <url>       Flair base URL (default: http://localhost:9926)
 *
 * Ctrl-C to stop.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, sign } from "node:crypto";

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const FLAIR_URL = get("--flair") ?? "http://localhost:9926";
const AGENT_ID  = get("--agent") ?? "anvil";
const INTERVAL  = parseInt(get("--interval") ?? "10", 10);
const HOME = homedir();
const KEY_PATH = get("--key")
  ?? (existsSync(join(HOME, ".tps", "identity", `${AGENT_ID}.key`))
      ? join(HOME, ".tps", "identity", `${AGENT_ID}.key`)
      : join(HOME, ".tps", "secrets", "flair", `${AGENT_ID}-priv.key`));

let since = get("--since") ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();

function loadPrivateKey() {
  const raw = readFileSync(KEY_PATH);
  try { return createPrivateKey(raw); } catch {
    const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
    return createPrivateKey({ key: Buffer.concat([pkcs8Header, Buffer.from(raw)]), format: "der", type: "pkcs8" });
  }
}

const _privKey = loadPrivateKey();

function makeAuthHeader(method, urlPath) {
  const ts    = Date.now().toString();
  const nonce = Math.random().toString(36).slice(2, 10);
  const payload = `${AGENT_ID}:${ts}:${nonce}:${method}:${urlPath}`;
  const sig   = sign(null, Buffer.from(payload), _privKey).toString("base64");
  return `TPS-Ed25519 ${AGENT_ID}:${ts}:${nonce}:${sig}`;
}

async function fetchEvents(sinceIso) {
  // Harper requires full ISO with milliseconds (.000Z) to parse as a query condition.
  // Do NOT encodeURIComponent -- Harper does not URL-decode %3A in condition values.
  const normalized = sinceIso.includes(".") ? sinceIso : sinceIso.replace(/Z$/, ".000Z");
  const urlPath = `/OrgEventCatchup/${AGENT_ID}?since=${normalized}`;
  const res = await fetch(`${FLAIR_URL}${urlPath}`, {
    headers: { Authorization: makeAuthHeader("GET", urlPath) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

function fmt(event) {
  const ts      = new Date(event.createdAt).toLocaleTimeString("en-US", { hour12: false });
  const author  = (event.authorId ?? "?").padEnd(10);
  const kind    = (event.kind ?? "?").padEnd(20);
  const scope   = event.scope ? `[${event.scope}] ` : "";
  const summary = (event.summary ?? "").slice(0, 80);
  return `${ts}  ${author}  ${kind}  ${scope}${summary}`;
}

console.log(`[flair-activity] streaming from ${since} (poll ${INTERVAL}s, agent=${AGENT_ID}) -- Ctrl-C to stop`);
console.log("-".repeat(80));

async function poll() {
  try {
    const events = await fetchEvents(since);
    if (!Array.isArray(events)) return;
    for (const e of events) console.log(fmt(e));
    if (events.length > 0) {
      since = new Date(new Date(events[events.length - 1].createdAt).getTime() + 1).toISOString();
    }
  } catch (err) {
    console.error(`[flair-activity] poll error: ${err.message}`);
  }
}

await poll();
setInterval(poll, INTERVAL * 1000);
