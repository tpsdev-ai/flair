- **Runnable two-node repro for the #1244 loss mechanism**
  (`test/repro/basecopy-retention-repro.mjs`). Boots an ephemeral, fully
  isolated two-node Harper cluster, partitions one node, writes rows only the
  surviving node holds, ages the partition past `logging.auditRetention`, and
  reconnects to force Harper's "bounded base-copy resync" — then asserts what
  that lane actually does to receiver-only rows, with a positive-control
  proving normal deletes do appear in `read_transaction_log`. A control lane
  reconnects within retention to distinguish base-copy from incremental
  catch-up. Nothing in it touches a production data directory or port.
