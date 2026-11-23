#!/usr/bin/env bash
# wait-for-harper.sh — wait for a Docker-hosted Harper to answer /Health.
#
# The CI E2E lane starts Harper with `harper install && harper dev /flair`
# inside a container and then polls /Health. Two failure modes made that poll
# flaky on loaded runners: the install could outlast a fixed poll count, and
# the loop kept sleeping after the container had already exited, so a slow
# install and a dead container surfaced as the same generic start failure.
#
# This script waits against an elapsed-time budget instead of a loop count, and
# checks the container on every poll. When the container has exited it fails at
# once with the exit code and the container logs.
#
# Usage:
#   wait-for-harper.sh <container> <url> [credentials-env] [budget-seconds]
#
#   container        Docker container name to inspect and to log on failure
#   url              /Health URL to poll
#   credentials-env  NAME of an environment variable holding `user:pass`; empty
#                    for an unauthenticated probe. The value never appears in
#                    this script's argv.
#   budget-seconds   elapsed-time budget (default: $HARPER_START_BUDGET_S, or
#                    300 when that is unset)
#
# Exit status: 0 once /Health answers; 1 when the container exits, when the
# budget runs out, or when the container cannot be inspected; 2 on bad usage.

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: wait-for-harper.sh <container> <url> [credentials-env] [budget-seconds]" >&2
  exit 2
fi

container=$1
url=$2
credentials_env=${3:-}
budget=${4:-${HARPER_START_BUDGET_S:-300}}

case "$budget" in
  '' | *[!0-9]*)
    echo "wait-for-harper: budget must be a whole number of seconds, got '$budget'" >&2
    exit 2
    ;;
esac

credential=""
if [ -n "$credentials_env" ]; then
  credential="${!credentials_env:-}"
  if [ -z "$credential" ]; then
    echo "wait-for-harper: credentials variable '$credentials_env' is unset or empty" >&2
    exit 2
  fi
fi

probe() {
  if [ -n "$credential" ]; then
    curl -sf -u "$credential" -o /dev/null "$url"
  else
    curl -sf -o /dev/null "$url"
  fi
}

report_failure() {
  echo "Full logs:"
  docker logs "$container" 2>&1 || true
  echo "---"
  echo "Trying direct curl with verbose:"
  if [ -n "$credential" ]; then
    curl -v -u "$credential" "$url" 2>&1 || true
  else
    curl -v "$url" 2>&1 || true
  fi
  exit 1
}

start=$SECONDS
last_report=0

while :; do
  elapsed=$((SECONDS - start))

  if probe; then
    echo "Harper ready after ${elapsed}s"
    exit 0
  fi

  if ! running=$(docker inspect -f '{{.State.Running}}' "$container" 2>&1); then
    echo "wait-for-harper: cannot inspect container '$container': $running" >&2
    exit 1
  fi
  running=${running%$'\n'}
  if [ "$running" != "true" ]; then
    exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$container" 2>/dev/null || true)
    echo "Harper container '$container' exited (exit code ${exit_code:-unknown}) before ${url} answered" >&2
    report_failure
  fi

  if [ "$elapsed" -ge "$budget" ]; then
    echo "Harper did not answer /Health within ${budget}s"
    report_failure
  fi

  if [ $((elapsed - last_report)) -ge 30 ]; then
    echo "waiting for Harper /Health: ${elapsed}s"
    last_report=$elapsed
  fi

  sleep 2
done
