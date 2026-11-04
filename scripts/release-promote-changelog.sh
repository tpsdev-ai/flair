#!/usr/bin/env bash
set -euo pipefail
version="$1"
shift
node scripts/changelog-fragments.mjs promote "$version" --with-dependencies "$@"
