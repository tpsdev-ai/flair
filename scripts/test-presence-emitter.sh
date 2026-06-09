#!/usr/bin/env bash
# Test: presence-emitter dry-run output for known PR states.
# Runs the emitter in --dry-run mode and validates the output format.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMITTER="$SCRIPT_DIR/presence-emitter.sh"
FAIL=0

run_test() {
    local desc="$1"
    local agent="$2"
    local expected_pattern="$3"
    shift 3

    echo -n "TEST: $desc ... "
    output=$(bash "$EMITTER" --agent "$agent" --dry-run "$@" 2>&1)

    if echo "$output" | grep -q "$expected_pattern"; then
        echo "PASS"
    else
        echo "FAIL"
        echo "  Expected pattern: $expected_pattern"
        echo "  Got: $output"
        FAIL=1
    fi
}

# Test 1: Agent with no open PRs -> idle, no task
run_test "no-open-prs => idle" "ember" "activity=idle"

# Test 2: Verify output has two lines (state line + flair command line)
echo -n "TEST: output has 2 lines ... "
output=$(bash "$EMITTER" --agent ember --dry-run 2>&1)
lines=$(echo "$output" | wc -l)
if [[ "$lines" -eq 2 ]]; then
    echo "PASS"
else
    echo "FAIL (got $lines lines)"
    FAIL=1
fi

# Test 3: --repos flag is accepted
echo -n "TEST: --repos flag accepted ... "
output=$(bash "$EMITTER" --agent ember --repos tpsdev-ai/flair --dry-run 2>&1)
if echo "$output" | grep -q "flair presence set"; then
    echo "PASS"
else
    echo "FAIL"
    echo "  Got: $output"
    FAIL=1
fi

# Test 4: Missing agent id errors out
echo -n "TEST: missing agent id => error ... "
output=$(bash "$EMITTER" --dry-run 2>&1 || true)
if echo "$output" | grep -qi "error"; then
    echo "PASS"
else
    echo "FAIL (expected error)"
    echo "  Got: $output"
    FAIL=1
fi

if [[ $FAIL -eq 0 ]]; then
    echo ""
    echo "All tests passed."
    exit 0
else
    echo ""
    echo "Some tests failed."
    exit 1
fi
