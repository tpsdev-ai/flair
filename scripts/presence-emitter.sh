#!/usr/bin/env bash
# Presence emitter — heartbeat script that infers agent activity from open PRs
# and updates Flair presence via `flair presence set`.
#
# Usage:
#   ./presence-emitter.sh [--agent <id>] [--repos <a,b>] [--dry-run]
#
# Env vars:
#   FLAIR_AGENT_ID  — default agent id
#   FLAIR_REPOS     — comma-separated repos (default: tpsdev-ai/flair,tpsdev-ai/cli)
#   RECENT_MINUTES  — threshold for "coding" vs "reviewing" (default: 5)
set -euo pipefail

DRY_RUN=false
AGENT_ID="${FLAIR_AGENT_ID:-}"
REPOS="${FLAIR_REPOS:-tpsdev-ai/flair,tpsdev-ai/cli}"
RECENT_MINUTES="${RECENT_MINUTES:-5}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --agent)   AGENT_ID="$2"; shift 2 ;;
        --repos)   REPOS="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$AGENT_ID" ]]; then
    echo "Error: agent ID required. Pass --agent <id> or set FLAIR_AGENT_ID." >&2
    exit 1
fi

# ─── Fetch open PRs across repos ──────────────────────────────────────────────
TMPDIR_PRES=$(mktemp -d)
trap 'rm -rf "$TMPDIR_PRES"' EXIT

ALL_PRS_FILE="$TMPDIR_PRES/all_prs.json"
echo '[]' > "$ALL_PRS_FILE"

IFS=',' read -ra REPO_LIST <<< "$REPOS"
idx=0
for repo in "${REPO_LIST[@]}"; do
    PR_FILE="$TMPDIR_PRES/prs_${idx}.json"
    idx=$((idx + 1))
    gh-as "$AGENT_ID" pr list \
        --repo "$repo" \
        --author "@me" \
        --state open \
        --json number,title,updatedAt,createdAt \
        --limit 50 \
        > "$PR_FILE" 2>/dev/null || echo '[]' > "$PR_FILE"

    # Tag each PR with its repo name and merge
    node -e "
        const fs = require('fs');
        const all = JSON.parse(fs.readFileSync('$ALL_PRS_FILE', 'utf8'));
        const more = JSON.parse(fs.readFileSync('$PR_FILE', 'utf8'));
        more.forEach(p => all.push({ ...p, repo: '$repo' }));
        fs.writeFileSync('$ALL_PRS_FILE', JSON.stringify(all));
    "
done

# ─── Infer activity + task ───────────────────────────────────────────────────
INFERENCE="$TMPDIR_PRES/inference.txt"
node -e "
    const fs = require('fs');
    const { execSync } = require('child_process');
    const now = Date.now();
    const threshold = $RECENT_MINUTES * 60 * 1000;
    const prs = JSON.parse(fs.readFileSync('$ALL_PRS_FILE', 'utf8'));

    if (!prs.length) {
        fs.writeFileSync('$INFERENCE', 'idle\n\n');
        process.exit(0);
    }

    const newest = prs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    const repo = newest.repo;
    const num = newest.number;
    const title = (newest.title || '').trim();

    // Check last commit time in this PR to distinguish coding vs reviewing.
    // gh pr view --json commits returns commit objects with committedDate.
    let activity = 'reviewing';
    try {
        const out = execSync(
            'gh-as $AGENT_ID pr view ' + num + ' --repo ' + repo + ' --json commits',
            { encoding: 'utf8' }
        );
        const data = JSON.parse(out);
        if (data.commits && data.commits.nodes && data.commits.nodes.length) {
            const lastCommit = data.commits.nodes[0];
            const commitTime = new Date(lastCommit.committedDate).getTime();
            if (now - commitTime < threshold) {
                activity = 'coding';
            }
        }
    } catch (e) {
        // If we can't fetch commits, default to reviewing
    }

    const task = repo + '#' + num + ': ' + title;
    fs.writeFileSync('$INFERENCE', activity + '\n' + task + '\n');
"

ACTIVITY=$(sed -n '1p' "$INFERENCE")
TASK=$(sed -n '2p' "$INFERENCE")

# ─── Emit ─────────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "true" ]]; then
    if [[ -n "$TASK" ]]; then
        echo "agent=$AGENT_ID activity=$ACTIVITY task='$TASK'"
        echo "flair presence set --activity $ACTIVITY --task '$TASK' --agent $AGENT_ID"
    else
        echo "agent=$AGENT_ID activity=$ACTIVITY"
        echo "flair presence set --activity $ACTIVITY --agent $AGENT_ID"
    fi
    exit 0
fi

if [[ -n "$TASK" ]]; then
    flair presence set --activity "$ACTIVITY" --task "$TASK" --agent "$AGENT_ID"
else
    flair presence set --activity "$ACTIVITY" --agent "$AGENT_ID"
fi
