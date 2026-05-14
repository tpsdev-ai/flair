# n8n Workflow Management

Programmatic activation/deactivation of n8n workflows — the approach we use for ops automation on rockit.

## The Problem

Direct SQLite edits to `workflow_entity.active` (or using `n8n update:workflow` while n8n is running) don't re-register schedule triggers in the in-memory scheduler. The schedule simply stops firing. Only the v1 public API's `POST /api/v1/workflows/:id/activate` (or flipping Active in the UI) properly registers the trigger.

**Root cause**: n8n tracks activation via `activeVersionId`, not the `active` boolean alone. The `activeWorkflowManager` in-memory scheduler only picks up workflows where `activeVersionId IS NOT NULL`. Direct SQLite edits that only set `active=1` without setting `activeVersionId` will not be picked up even on restart.

## Recommended Approach: v1 Public API (live instance)

The **v1 public API** is the correct tool for managing workflows on a **running** n8n instance. It updates the DB AND calls the in-memory `ActiveWorkflowManager.add()` to register triggers immediately — no restart needed.

### Endpoints

| Action | Method | Endpoint | Body |
|---|---|---|---|
| Activate | `POST` | `/api/v1/workflows/:id/activate` | `{}` or `{"versionId": "..."}` |
| Deactivate | `POST` | `/api/v1/workflows/:id/deactivate` | (none) |
| List | `GET` | `/api/v1/workflows` | — |
| Get one | `GET` | `/api/v1/workflows/:id` | — |

### Authentication

All v1 API calls require `X-N8N-API-KEY` header with a valid API key (see [API Key Generation](#api-key-generation) below).

### Examples

```bash
# Activate workflow
curl -X POST "http://127.0.0.1:5678/api/v1/workflows/$WORKFLOW_ID/activate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'

# Deactivate workflow
curl -X POST "http://127.0.0.1:5678/api/v1/workflows/$WORKFLOW_ID/deactivate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"

# Check if workflow is active
curl -s "http://127.0.0.1:5678/api/v1/workflows/$WORKFLOW_ID" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" | python3 -c "import json,sys; print(json.load(sys.stdin)['active'])"
```

See `scripts/n8n/activate-workflow.sh` for a reusable wrapper.

## Why PATCH Doesn't Work

n8n's v1 API docs mention `PATCH /api/v1/workflows/:id` with `{ "active": true }`. **This returns 405 Method Not Allowed on n8n 1.123.38.** The documented activation endpoints are `POST /api/v1/workflows/:id/activate` and `POST /api/v1/workflows/:id/deactivate`.

## Alternative Approaches

### Approach 2: CLI when n8n is stopped

The `n8n update:workflow` CLI command works when n8n is **not running**. It updates both `active` and `activeVersionId` in the DB. On the next `n8n start`, `ActiveWorkflowManager.init()` reads `getAllActiveIds()` and registers all workflows with non-null `activeVersionId`.

```bash
# Stop n8n
launchctl stop ai.tpsdev.n8n

# Activate/deactivate via CLI
N8N_PATH="/opt/homebrew/opt/node@24/bin" npx n8n@1.123.38 update:workflow --id=$WORKFLOW_ID --active=true
# or
N8N_PATH="/opt/homebrew/opt/node@24/bin" npx n8n@1.123.38 update:workflow --id=$WORKFLOW_ID --active=false

# Start n8n
launchctl start ai.tpsdev.n8n
```

**Caveats**:
- `update:workflow` is deprecated (n8n v2 will replace it with `publish:workflow`/`unpublish:workflow`)
- Requires a full stop/start cycle (downtime for all workflows)
- `npx` needs node@24 (`/opt/homebrew/opt/node@24/bin/node`)

### Approach 3: Internal REST API (editor UI)

The `/rest/workflows/:id/activate` endpoint is what the editor UI uses. It requires session-based auth (cookie from `/rest/login`), which needs the admin password. Not practical for automation without storing credentials.

```bash
# Requires session cookie from /rest/login
curl -X POST "http://127.0.0.1:5678/rest/workflows/$WORKFLOW_ID/activate" \
  -b "fern-uid=...; n8n.session=..."
```

**Not recommended** for ops automation — session cookies expire and the password is a higher-value secret than an API key.

## API Key Generation

The v1 API key is a JWT signed with a secret derived from the encryption key. To create one programmatically:

```javascript
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('fs');

// Read encryption key from n8n config
const config = JSON.parse(fs.readFileSync(process.env.HOME + '/.n8n/config', 'utf8'));
const encKey = config.encryptionKey;

// Derive JWT secret: SHA256 of every-other-character of encryption key
let baseKey = '';
for (let i = 0; i < encKey.length; i += 2) {
  baseKey += encKey[i];
}
const jwtSecret = crypto.createHash('sha256').update(baseKey).digest('hex');

// Sign JWT with user's ID (from `user` table in SQLite)
const userId = '<user-uuid-from-sqlite>'; // e.g., 'a6ce7ac9-ef6d-4157-835a-4b0f01dc788a'
const apiKey = jwt.sign(
  { sub: userId, iss: 'n8n', aud: 'public-api' },
  jwtSecret
);

// Store the returned key in the user_api_keys table so it persists

console.log('API key:', apiKey);
```

Once stored in the DB, the key is valid until deleted. No expiration by default.

**Security note**: The encryption key is needed to derive the JWT secret. This is the same key used to decrypt workflow credentials. If the encryption key is compromised, so are the credentials. Keep it scoped to the n8n user.

## Why Direct SQLite Edits Don't Work

The `workflow_entity` table has two activation fields:
- `active` (boolean): UI flag
- `activeVersionId` (varchar): points to the `workflow_history` record that defines the active version

The `ActiveWorkflowManager` only considers workflows where `activeVersionId IS NOT NULL`. If you only flip `active=1` without setting `activeVersionId`, n8n never picks up the workflow — not on restart, not on refresh.

Even with both fields set correctly, a live n8n instance has an in-memory scheduler that doesn't re-read the DB. Only the v1 API (or UI toggle) calls `activeWorkflowManager.add()` to register the trigger in-memory.

## Quick Reference

| Scenario | Method | Restart needed? |
|---|---|---|
| Activate on running n8n | `POST /api/v1/workflows/:id/activate` | No |
| Deactivate on running n8n | `POST /api/v1/workflows/:id/deactivate` | No |
| Activate when stopped | `n8n update:workflow --id=X --active=true` | Yes |
| Direct DB edit (active + activeVersionId) | SQLite `UPDATE` | Yes, on restart |
| Direct DB edit (active only) | SQLite `UPDATE` | **Won't work** — needs activeVersionId too |
