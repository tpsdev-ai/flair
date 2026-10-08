#!/usr/bin/env bash
set -euo pipefail
repo=$(pwd -P)
scratch=$(mktemp -d "${TMPDIR:-${RUNNER_TEMP:?}}/expiry-mutations.XXXXXX")
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT
mkdir "$scratch/repo"
tar --exclude=./.git --exclude=./node_modules -cf - . | tar -xf - -C "$scratch/repo"
ln -s "$repo/node_modules" "$scratch/repo/node_modules"
cd "$scratch/repo"
cp resources/AgentSeed.ts "$scratch/AgentSeed.ts"
cp resources/Federation.ts "$scratch/Federation.ts"
restore() {
  cp "$scratch/AgentSeed.ts" resources/AgentSeed.ts
  cp "$scratch/Federation.ts" resources/Federation.ts
}
suite=test/integration/feed-ephemeral-expiry-e2e.test.ts
bun test "$suite"
for path in AgentSeed Federation; do
  restore
  python3 - "$path" <<'PYCODE'
from pathlib import Path
import sys
path = Path("resources") / (sys.argv[1] + ".ts")
text = path.read_text()
if sys.argv[1] == "AgentSeed":
    old, new = "stampEphemeralExpiry(record);", ";"
else:
    old = "stampEphemeralExpiry(incoming, local, { incoming: true })"
    new = "null"
assert text.count(old) == 1
path.write_text(text.replace(old, new))
PYCODE
  bun run build
  if [ "$path" = AgentSeed ]; then
    title="AgentSeed ignores supplied expiry and stores a default for an ephemeral starter memory"
  else
    title="signed receive stores receiver-clock expiry when the incoming row wins last-write-wins without expiry"
  fi
  if bun test "$suite" --test-name-pattern "$title" > "$scratch/$path.log" 2>&1; then
    cat "$scratch/$path.log"
    exit 1
  fi
  cat "$scratch/$path.log"
  grep -F "(fail)" "$scratch/$path.log" | grep -F "$title"
  grep -E '^ 1 fail$' "$scratch/$path.log"
  grep -F 'expect(received).toBeGreaterThanOrEqual(expected)' "$scratch/$path.log"
done
