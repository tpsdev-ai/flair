- **Federation can no longer complete a pending agent key.**

  A record that reaches the merge plan and would change a stored `pending` key
  is skipped whole as `agent_pending_key_not_federated`, unless the status rule
  refused it first as `agent_status_not_federated`. Earlier validation keeps
  its own reason, such as `future_timestamp`.
