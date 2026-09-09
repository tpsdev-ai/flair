#!/bin/sh
# start-flair-with-admin-pass.sh — product-owned launchd launcher (flair#1573).
#
# Reads the Flair admin password from a 0600 file and execs Harper
# NON-INTERACTIVELY. The secret never appears in the launchd plist: it enters
# the process environment here, from the file, at start time. This is the
# product shape of the no-inline-secret pattern — the plist's ProgramArguments
# point at this launcher instead of embedding HDB_ADMIN_PASSWORD.
#
# Usage: start-flair-with-admin-pass.sh <admin-pass-file> <node> <harper-bin>
#
#   admin-pass-file  path to the 0600 file holding the admin password
#   node             the node binary to exec
#   harper-bin       Harper's entrypoint (harper.js)
#
# HDB_ADMIN_USERNAME is already in the launchd environment (it is not a
# secret); only the password is read from the file here. HOME, PATH and the
# Harper config (HARPER_SET_CONFIG / ROOTPATH / FLAIR_MODELS_DIR) are also
# supplied by the plist's EnvironmentVariables, so Harper boots without ever
# hitting its interactive readline prompt under launchd's minimal env.

set -eu

ADMIN_PASS_FILE="$1"
NODE="$2"
HARPER_BIN="$3"

if [ ! -f "$ADMIN_PASS_FILE" ]; then
  echo "start-flair-with-admin-pass: admin-pass file not found: $ADMIN_PASS_FILE" >&2
  exit 1
fi

# Read the secret. Command substitution strips a trailing newline, which is
# what `flair init` writes (base64url + "\n"); the value itself is preserved
# verbatim by the double quotes.
ADMIN_PASS="$(cat "$ADMIN_PASS_FILE")"
if [ -z "$ADMIN_PASS" ]; then
  echo "start-flair-with-admin-pass: admin-pass file is empty: $ADMIN_PASS_FILE" >&2
  exit 1
fi

export HDB_ADMIN_PASSWORD="$ADMIN_PASS"

# exec (not spawn) so launchd tracks Harper itself — the job's PID is Harper's
# PID, and KeepAlive restarts the real service rather than a dead launcher.
exec "$NODE" "$HARPER_BIN" run .
