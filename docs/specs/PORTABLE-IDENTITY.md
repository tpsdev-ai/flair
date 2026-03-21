# Portable Agent Identity — Spec

## Summary

Make agent identity (soul + memories + keys + grants) fully portable
across Flair instances, runtimes, and machines. Enable team memory
sharing without requiring a shared Flair server.

## Scenarios

### 1. Clone agent to a new machine

**User:** "I want to move Flint to a Claude Code VM."

```bash
# On source (rockit):
flair export flint --output flint-identity.tar.gz
# Includes: soul, memories, public key, grants (NOT private key by default)

# On target (VM):
flair import flint-identity.tar.gz --admin-pass newpass
# Registers agent, restores soul + memories
# Generates new key pair (fresh identity on this instance)
```

**With key migration** (same cryptographic identity):
```bash
flair export flint --include-key --output flint-full.tar.gz
# Now includes encrypted private key

flair import flint-full.tar.gz --admin-pass newpass --key-password mypass
# Restores everything including the original key
```

### 2. Share team memory

**User:** "I want all agents to see shared project context."

```bash
# Create a shared agent for team context
flair agent add team-context

# Any agent can write to it
flair memory add --agent team-context --content "Deploy process: PR → CI → staging → prod"

# Grant read access to team members
flair grant team-context flint --scope read
flair grant team-context claude-dev --scope read

# Now flint's bootstrap includes team-context memories
flair bootstrap --agent flint
# Shows: own memories + team-context memories (via grant)
```

### 3. Git-backed sync

**User:** "I want agent memory version-controlled and synced across machines."

```bash
# Export to a git repo
flair sync push --agent flint --repo ~/repos/agent-data
# Creates: agents/flint/{soul.json, memories.json, grants.json}
# Commits + pushes

# On another machine
flair sync pull --agent flint --repo ~/repos/agent-data
# Pulls latest, merges into local Flair instance
# Conflict resolution: newer timestamp wins
```

### 4. Backup/restore improvements

```bash
# Export single agent (already works)
flair backup --agents flint --output flint.json

# Restore with key file
flair restore flint.json --admin-pass pass --key ~/.flair/keys/flint.key

# List what's in a backup
flair backup inspect flint.json
# Agent: flint (48 memories, 7 soul entries, 2 grants)
```

## Implementation Plan

### Phase 1: Export/Import (rename from backup/restore for single-agent use)
- `flair export <agent>` — single-agent export with optional key
- `flair import <file>` — restore agent on target instance
- `flair backup inspect` — show backup contents
- Key encryption for export (age or password-based)

### Phase 2: Team Memory
- `flair grant` and `flair revoke` already exist
- Bootstrap includes granted memories (already works via SemanticSearch)
- Document the shared-agent pattern
- Test grant persistence across backup/restore

### Phase 3: Git Sync
- `flair sync push --agent <id> --repo <path>`
- `flair sync pull --agent <id> --repo <path>`
- Timestamp-based conflict resolution
- Incremental sync (only new/changed memories)

## Non-Goals
- Real-time replication between Flair instances (use Fabric for that)
- Multi-master conflict resolution (git sync is single-writer per agent)
- Cross-agent memory merging (agents stay isolated, grants are read-only)

## Security Considerations
- Private keys NEVER exported by default
- Key export requires explicit `--include-key` flag
- Exported keys encrypted with user-provided password
- Grants are agent-scoped — can't escalate to admin
- Git repos should be private (contain memory content)
