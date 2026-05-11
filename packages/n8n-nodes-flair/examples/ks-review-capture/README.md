# Worked example: K&S review capture → Flair

This is the worked-example workflow for `@tpsdev-ai/n8n-nodes-flair`. It captures inbound TPS-mail review notes from the Kern (architecture) and Sherlock (security) review agents into Flair as structured, tagged memories — turning ephemeral review reasoning into a searchable, federated archive.

It's also our first dogfood loop on n8n: every K&S review verdict that lands in Flint's TPS-mail inbox gets persisted with semantic search, durable across sessions and orchestrators.

## Why this workflow earns the worked-example slot

The q3qf positioning table calls out Flair's **agent-knowledge shape** vs n8n's built-in conversation-buffer memory connectors. This workflow is that shape in practice:

- Captures **reasoning** (multi-paragraph review prose), not turn-by-turn chat
- Tags every memory with the agent who wrote it, the PR number it's about, and the date — making queries like *"what does Sherlock typically flag in auth code"* or *"Kern's view on schema migrations"* possible six months later
- Writes through the `@tpsdev-ai/n8n-nodes-flair` **Flair Write** node — the structured-write surface, not the LangChain chat-buffer adapter
- Single-direction (TPS-mail → Flair); no cross-orchestrator chatter

A second worked example (Pulse intel → Flair) was scoped originally but Pulse posts to Discord directly and never crosses TPS mail; this captured the higher-volume, higher-reasoning-density signal source instead.

## Pipeline

```
Schedule (5 min) → ls ~/.tps/mail/flint/new/*.json → Split paths
  → Read each file → Parse JSON → Filter from ∈ {kern, sherlock}
  → Dedup by mail.id (workflow static data)
  → Format (compose content, derive tags, set subject)
  → Flair Write (durability=persistent, type=decision)
```

Notes on each step:

- **Schedule trigger** — every 5 minutes. n8n also has a `Local File Trigger` node that watches a directory; we picked the schedule pattern because it doesn't compete with Flint's own mail consumer for file events. The two consumers cohabit cleanly: Flint may move files, n8n only reads.
- **List inbox files** — bash one-liner. Returns one path per line on `stdout`; the next node splits it. Avoids a node-specific "list directory" abstraction and keeps the workflow portable to anywhere a similar maildir lives.
- **Read + parse** — n8n's `Read Binary File` + `Extract from File` (`fromJson` mode). The mail file is dropped into `$json.mail`.
- **Filter K&S only** — `containedInList` on `mail.from`. Flexible if you want to add `host` or `ember` later — comma-extend the list value.
- **Skip already-written** — the dedup node uses `getWorkflowStaticData('global').processedIds` to avoid re-writing a memory each tick. Trims itself at >5000 entries (keeps last 4000) so the static data file doesn't bloat. Mail files in `flint/new/` may sit for hours before Flint drains them; without this, every tick would write the same review again.
- **Format memory** — composes a multi-line content string, tries to extract a PR number from the body to tag/subject, and produces the `tags` and `subject` fields the Flair Write node consumes. PR-tagged memories share a `subject` so they group cleanly in `getBySubject` queries.
- **Flair Write** — durability `persistent` (review reasoning is high-value, deserves the durable tier), type `decision` (review verdicts are decisions), tags surface the agent + date + PR for cross-cutting search.

## Setup

1. **Install the node**:
   ```sh
   # in your n8n custom-extensions dir (~/.n8n/custom by default)
   npm install @tpsdev-ai/n8n-nodes-flair
   ```
   Or, if you ship a community-nodes-enabled n8n, add it via the in-app community node installer.

   **Required env var on the n8n host**:
   ```
   NODE_FUNCTION_ALLOW_BUILTIN=fs,path
   ```
   The Code node that reads the TPS-mail inbox needs `fs` + `path` from Node's standard library. n8n blocks built-ins by default (sensible for multi-tenant cloud installs); self-hosted operators need to opt in. If unset, the workflow fails with `Cannot find module 'fs'` at the first node.

2. **Configure the Flair credential**:
   - Settings → Credentials → New → Flair API
   - Base URL: `http://127.0.0.1:9926` (or your Flair host)
   - Agent ID: any agent who should *own* the imported memories (e.g., `flint`, `pulse`, `archive`)
   - Admin Password: contents of `~/.flair/admin-pass`

3. **Import this workflow**:
   - Workflows → Import from File → select `workflow.json` from this dir
   - Open the **Flair Write** node, point its credential at the Flair API credential you just created
   - Adjust the inbox path in **List inbox files** if your TPS mail lives elsewhere

4. **Activate** — toggle the workflow active. First tick within 5 minutes.

5. **Verify in Flair**:
   ```sh
   # search by tag
   FLAIR_URL=http://127.0.0.1:9926 flair memory search "" \
     --agent flint --tags kind:review --limit 5

   # search by PR
   FLAIR_URL=http://127.0.0.1:9926 flair memory search "" \
     --subject pr-380 --limit 10
   ```

## Tuning knobs

- **Filter expansion**: add `host`, `ember`, or any agent to the `containedInList` value to capture more sources. Pair with a `kind:` tag-update in the Format step so the search story stays clean.
- **Deeper formatting**: the Format step is a Code node — you can pull more structure out of the body (e.g., bullet-point analysis vs paragraph prose), set `validFrom`/`validTo` for time-bounded reasoning, or branch durability by content (security flags → `permanent`, info → `standard`).
- **Cross-instance**: this workflow writes to *one* Flair instance. The hub-spoke federation pair (rockit ↔ Fabric) propagates the writes without further n8n changes — every memory captured here becomes searchable from every federated peer.

## Operational notes

- The dedup index is workflow-static-data scoped, so re-importing the workflow (new ID) starts fresh. If you want hard de-duplication across imports, key the dedup off `mail.id` directly into Flair using `flair.memory.write` with a deterministic ID or a `foreignId` tag, and let Flair's content-hash dedup handle it.
- The schedule trigger is 5 min on purpose — fast enough for review-mail freshness, slow enough that the inbox listing isn't burning CPU.
- If Flint's inbox is full (the 100-message hard cap), TPS bounces inbound mail; this workflow only sees what's actually delivered. The inbox-cap is a separate operational concern (see `reference_flint_inbox_cap`).

## What this dogfood loop is for

Six months from now, when we want to know *what reasoning Sherlock typically applies to bridge-loading code*, we'll have a real archive. Today's review mail is reasoning that decays the moment the Discord/inbox scrolls past. This workflow is the bet that capturing the reasoning durably will compound into measurable signal.

If after a month of dogfooding the search results turn up genuine value (we use them to inform new specs, new dispatches, new architecture decisions), we lift the workflow to a more durable host (own VM, or Pulse VM if we consolidate) and add it to the standard rockit deploy. If signal is noisy, no infra to dismantle — just deactivate.
