- **An inbound federation record can no longer complete a pending agent key, and is skipped as `agent_pending_key_not_federated`.**

  The sync-in merge applies a peer's Agent rows through the raw table handle, so
  a paired hub could previously deliver a key onto a local `pending` row. The
  skip is distinct from the `agent_status_not_federated` refusal, which keeps its
  own name.
