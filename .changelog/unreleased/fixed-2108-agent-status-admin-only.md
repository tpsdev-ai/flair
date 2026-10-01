- **`Agent.status` is settable through the Agent resource only by an administrator or a trusted internal call, and not by a federated peer (Closes #2108).**

  An authenticated non-admin agent's write that includes `status` is refused with `403` (an anonymous request gets `401`) naming the field and pointing at Presence, and writes nothing — not the `status`, and not the other fields in the same request. A federated peer's record that would change an existing principal's `status` is skipped whole and reported as `agent_status_not_federated`. Other self-editable Agent fields are unchanged.
