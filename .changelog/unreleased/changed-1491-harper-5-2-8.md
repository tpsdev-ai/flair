- **harper pinned at 5.2.8 (was 5.2.7).** Latest stable on npm as of 2026-09-02; Flair stays
  on Harper's latest stable so we are never working around something already shipped
  upstream (keep-current policy, 0-day cooldown for harper). The lockfile moves only harper
  and its own dependencies (12 lines). Nothing changes for operators: the 5.2.x store format
  is unchanged and the one documented patch-level break inside 5.2 (5.2.7-written LZ4 stores
  are forward-only against 5.2.0, see docs/upgrade.md) is unaffected. The five vendor-pinned
  audit allowlist entries (@fastify/static, lodash) stay: 5.2.8 still ships @fastify/static
  9.3.0 and lodash 4.17.21.
