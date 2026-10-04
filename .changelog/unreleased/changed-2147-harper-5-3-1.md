- **Updates `harper` from 5.2.8 to 5.3.1.** Its npm-shrinkwrap resolves fastify 5.12.5, joi 17.13.8 and moment 2.31.0, clearing thirteen dependency-audit allowlist entries; flair's RocksDB admin-user reader now accepts 5.3's generation-suffixed `hdb_user/@<uuid>` primary store. Signed Presence collection reads authenticate before Harper's auth layer. The unused optional full-text binding is omitted.

  > **Heads-up:** Harper 5.3's RocksDB storage format is one-way. A build older
  > than 5.3 opens the bare store names and reads tables created under 5.3 as
  > empty, so a data directory upgraded to 5.3 must not be served by an older
  > flair.
