- **Updates `harper` from 5.2.8 to 5.3.1.** Removes 14 dependency-audit allowlist entries (47 → 33), with packed-install audit-gate evidence for each retirement; flair's RocksDB admin-user reader now accepts 5.3's generation-suffixed `hdb_user/@<uuid>` primary store.

  - `fastify`: `GHSA-w2qp-rph6-63g4`, `GHSA-3m5p-2c4r-xxw2`, `GHSA-hwr6-493r-vm6h`, `GHSA-9q9j-q6p8-xq58`, `GHSA-p68q-wchp-6fh7`, `GHSA-667r-xxjv-c9mm`, `GHSA-4mh8-r7rc-xpvc`.
  - `joi`: `GHSA-gg4h-3hg2-grpc`, `GHSA-6w3j-5fw6-r9vr`, `GHSA-6h2x-m376-mqjq`, `GHSA-wr44-6hxh-3jwq`.
  - `moment`: `GHSA-4p3w-j4w9-5jqw`.
  - `fast-uri`: `GHSA-5jgf-p345-68v8`, `GHSA-fph4-wmhf-6fwf`.

  > **Heads-up:** A data directory upgraded to Harper 5.3 must not be served
  > by an older flair. The only full rollback is restoring the pre-upgrade physical
  > data-directory snapshot (`flair snapshot restore <path>`). `flair backup`/`restore`
  > logically exports/imports only Agent, Memory and Soul rows through a running
  > server; it can transfer those rows into a fresh compatible instance.
