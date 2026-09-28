- **CI boot scripts delegate inline Node calls to a self-contained probe helper.**
  Inline `node -e` / `node -p` / `node --eval` code in `scripts/ci/check-instance-boot.sh` is replaced by `boot-probe.mjs` calls, and the canary test now rejects any new inline Node bodies in inspected shell scripts.

  (Closes #1859)
