- Team Concierge example (`examples/team-concierge/`): a runnable ADK agent on
  adk-flair that commits team knowledge to Flair through two shape-enforced
  write helpers (`record_decision` → persistent+shared, `record_personal` →
  standard+private — fixed classes, never model-selected), scopes users by the
  connector's `adk:concierge:<user>` tag, and ships `scripts/verify.sh`
  executing the scenario's isolation and distillation claims (with inline
  mutation checks) against a live instance (#1229, epic #1228)
