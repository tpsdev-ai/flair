"""Verify chat against the deployed Team Concierge on Agent Engine.

Usage (Cloud Shell, after deploy.sh — ADC supplies credentials, no keys here):

    python3 chat.py --resource projects/<p>/locations/<r>/reasoningEngines/<id> \
        --user <your-handle> "We decided to adopt X because Y"

--user becomes the ADK user_id, which the connector scopes into the compound
tag adk:concierge:<user>. Use your real handle: the verify step then checks
that the decision landed on the hub under that scope, attributed to the
concierge's Flair identity.

The deployed instance registers stream_query(message, user_id[, session_id])
(google-adk 2.7.1 registers these class methods at deploy); the vertexai
client binds them on agent_engines.get(). This script prints streamed events'
text parts and nothing else — no env, no headers, no key material.
"""

from __future__ import annotations

import argparse
import sys


def _event_texts(event) -> list[str]:
    """Text parts of one streamed event (dict-shaped over the wire)."""
    if not isinstance(event, dict):
        return []
    content = event.get("content") or {}
    parts = content.get("parts") or []
    return [p["text"] for p in parts if isinstance(p, dict) and p.get("text")]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--resource",
        required=True,
        help="projects/<p>/locations/<r>/reasoningEngines/<id> (printed by deploy.sh)",
    )
    parser.add_argument(
        "--user",
        required=True,
        help="ADK user_id -> adk:concierge:<user> tag scope on the hub",
    )
    parser.add_argument("message", help="one chat message to send")
    args = parser.parse_args()

    segments = args.resource.split("/")
    if len(segments) < 6 or segments[0] != "projects" or segments[2] != "locations":
        print(
            "chat.py: --resource must be the full name "
            "projects/<p>/locations/<r>/reasoningEngines/<id> "
            f"(got: {args.resource})",
            file=sys.stderr,
        )
        return 2

    import vertexai  # deferred: import cost only after arg validation

    client = vertexai.Client(project=segments[1], location=segments[3])
    engine = client.agent_engines.get(name=args.resource)

    got_text = False
    for event in engine.stream_query(message=args.message, user_id=args.user):
        for text in _event_texts(event):
            got_text = True
            print(text)
    if not got_text:
        print(
            "chat.py: the query streamed no text events. Check the instance's "
            "logs in Cloud Logging (RUNBOOK: failure modes) — a memory-service "
            "boot failure surfaces there, not here.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
