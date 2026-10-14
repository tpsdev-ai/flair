- **An inbound federation record can no longer complete a pending agent key; unless the status rule refused it first, it is skipped as `agent_pending_key_not_federated`.**

  The sync-in merge applies a peer's Agent rows through the raw table handle, so
  a paired hub could previously deliver a key onto a local `pending` row. The
  skip is distinct from the `agent_status_not_federated` refusal, which keeps its
  own name and runs first: a record that also changes the agent's status is
  counted as `agent_status_not_federated`.
