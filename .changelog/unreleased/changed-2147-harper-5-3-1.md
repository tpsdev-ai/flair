- **Updates `harper` from 5.2.8 to 5.3.1.** Its npm-shrinkwrap resolves fastify 5.12.5, joi 17.13.8 and moment 2.31.0, clearing thirteen dependency-audit allowlist entries; flair's RocksDB admin-user reader now accepts 5.3's generation-suffixed `hdb_user/@<uuid>` primary store.

  > **Heads-up:** A data directory upgraded to Harper 5.3 must not be served
  > by an older flair. The remedy is restoring the pre-upgrade snapshot, or a
  > `flair backup` export taken on the older version.
