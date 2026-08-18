"""Team Concierge — an ADK front-office agent that commits team knowledge to Flair.

One ADK app (``concierge``) on adk-flair's FlairMemoryService → one Flair agent
identity. Users are scoped by the connector's compound tag
``adk:concierge:<user>`` (an application-level filter, NOT an authz wall — see
the README's limitation paragraph). Teammates read what the Concierge records
through their OWN Flair identities (MCP, CLI, native paths).

Write surface (the whole point of this file):

  The LLM can write memory ONLY through two shape-enforced helpers. Each
  helper fixes its durability + visibility INSIDE the function body — the
  model supplies content, never flags. The per-user tag derives from the
  authenticated ADK session's ``user_id`` (via ToolContext), never from model
  output. The Agent's ``tools`` list is the allowlist: memory ops only — no
  soul writes, no workspace writes, no org events, no raw memory_store.

    record_decision(text)  -> durability="persistent", visibility="shared"
                              (team knowledge — org-open, survives curation)
    record_personal(text)  -> durability="standard",   visibility="private"
                              (per-user context — concierge-identity-only)

  Session episodes (raw turns) are persisted by the after-agent callback as
  durability="standard", visibility="private" — explicitly, not via the
  server's durability-keyed default (every write-site sets visibility
  explicitly; a shipped default is a trust anchor, flair#1222).
"""

from __future__ import annotations

import inspect
import os
import uuid
from typing import Any, Sequence

from google.adk import Agent
from google.adk.memory.memory_entry import MemoryEntry
from google.adk.tools import ToolContext, load_memory, preload_memory
from google.genai import types

from adk_flair import FlairMemoryService

APP_NAME = "concierge"

# Model is not load-bearing for this example (spec §5) — any ADK-supported
# model string works. Default: native Gemini; override with ADK_MODEL.
MODEL = os.environ.get("ADK_MODEL", "gemini-2.5-flash")


# ─── Connector capability gate ───────────────────────────────────────────────
# record_decision needs adk-flair's explicit durability/visibility knobs on
# add_memory (shipped in 0.44.13, flair#1234/#1237). The stock 0.44.12
# add_memory hardcodes durability="standard" and has no visibility support at
# all — silently downgrading a "team decision" to a private row would be the
# exact failure this example exists to demonstrate against. Fail at import,
# loudly, with the remedy — never at first use inside a chat session.
def _assert_connector_supports_write_knobs() -> None:
    params = inspect.signature(FlairMemoryService.add_memory).parameters
    if "durability" not in params or "visibility" not in params:
        raise RuntimeError(
            "adk-flair >= 0.44.13 is required: this installed version's "
            "add_memory() has no durability/visibility parameters, so "
            "record_decision cannot produce a persistent+shared row. "
            "Upgrade with `pip install -U adk-flair` (or, from a flair repo "
            "checkout, `pip install -e packages/adk-flair`)."
        )


_assert_connector_supports_write_knobs()


# ─── Memory service resolution ───────────────────────────────────────────────


def _flair_service(tool_context: ToolContext) -> FlairMemoryService:
    """The runner's memory service, required to be a FlairMemoryService.

    There is deliberately NO fallback write channel: if the runner was wired
    with a different memory service, refuse with the remedy instead of
    silently writing somewhere with different durability semantics.
    """
    service = tool_context.get_invocation_context().memory_service
    if isinstance(service, FlairMemoryService):
        return service
    raise RuntimeError(
        "The Team Concierge requires FlairMemoryService as the runner's "
        "memory service (got: "
        f"{type(service).__name__ if service is not None else 'None'}). "
        "Start it via scripts/run_chat.sh, or pass "
        '--memory_service_uri="flair://localhost:19926" to adk web.'
    )


def _entry(text: str, author: str, entry_id: str | None = None) -> MemoryEntry:
    return MemoryEntry(
        id=entry_id,
        content=types.Content(role="model", parts=[types.Part(text=text)]),
        author=author,
    )


# ─── The two shape-enforced write helpers (the LLM's ONLY write surface) ─────
#
# Each write CLASS is a frozen module-level constant — the single source for
# both the add_memory call and the confirmation returned to the model, so the
# report can never claim a class the write didn't use. These are never
# parameters and never model-selected (Sherlock hard requirement, flair#1229
# review): a helper that took visibility as an argument would collapse the
# visibility discipline.

_DECISION_CLASS = {
    "durability": "persistent",  # team knowledge survives curation cycles
    "visibility": "shared",      # org-open: the shared lane IS the product
}
_PERSONAL_CLASS = {
    "durability": "standard",    # personal context is expirable working set
    "visibility": "private",     # concierge-identity-only, tag-scoped per user
}
_EPISODE_CLASS = {
    "durability": "standard",    # raw turns: distillation input (#1205)
    "visibility": "private",     # explicit — never the durability-keyed default
}


async def record_decision(decision: str, tool_context: ToolContext) -> dict:
    """Record a team decision, constraint, or agreed piece of spec/PR context.

    Use this when the user states something the WHOLE TEAM should be able to
    retrieve later: a decision made, a constraint adopted, context about a
    spec or PR. Write one self-contained statement including the why.

    Args:
        decision: The decision or constraint, as one self-contained statement.

    Returns:
        Confirmation including the memory class that was written.
    """
    service = _flair_service(tool_context)
    # user_id comes from the authenticated ADK session (ToolContext.user_id is
    # a read-only property over the invocation context) — the model cannot
    # write "as" another user. The connector derives the compound tag
    # adk:concierge:<user> from app_name+user_id internally.
    user_id = tool_context.user_id
    await service.add_memory(
        app_name=APP_NAME,
        user_id=user_id,
        memories=[_entry(decision, author=user_id)],
        **_DECISION_CLASS,  # FIXED write class — see the constant above
    )
    return {
        "status": "recorded",
        "memory_class": "team_decision",
        **_DECISION_CLASS,
        "note": "Retrievable by every agent identity on this Flair instance.",
    }


async def record_personal(note: str, tool_context: ToolContext) -> dict:
    """Record personal context or a preference about the current user.

    Use this for things that concern ONLY this user — preferences, working
    style, personal context. Not for team decisions (use record_decision).

    Args:
        note: The personal context or preference, as one statement.

    Returns:
        Confirmation including the memory class that was written.
    """
    service = _flair_service(tool_context)
    user_id = tool_context.user_id
    await service.add_memory(
        app_name=APP_NAME,
        user_id=user_id,
        memories=[_entry(note, author=user_id)],
        **_PERSONAL_CLASS,  # FIXED write class — see the constant above
    )
    return {
        "status": "recorded",
        "memory_class": "personal_context",
        **_PERSONAL_CLASS,
        "note": "Visible only to the concierge identity, scoped to this user.",
    }


# ─── Session episode persistence (raw turns → distillation input, #1205) ─────


def _event_text(event: Any) -> str | None:
    """Extract text from an ADK Event (mirrors the connector's heuristic)."""
    content = getattr(event, "content", None)
    if content is not None:
        texts = [
            str(t)
            for p in (getattr(content, "parts", None) or [])
            if (t := getattr(p, "text", None))
        ]
        if texts:
            return " ".join(texts)
    text = getattr(event, "text", None)
    return str(text) if text else None


async def persist_session_episodes(
    memory: FlairMemoryService,
    *,
    app_name: str,
    user_id: str,
    session_id: str,
    events: Sequence[Any],
) -> int:
    """Write session events as episode memories: standard + private, EXPLICIT.

    Rides add_memory (the only connector write surface with the explicit
    knobs) rather than add_events_to_memory, so the visibility of the episode
    lane is set at the write-site instead of inherited from the server's
    durability-keyed default (spec §3: no write relies on the default).

    Deterministic per-event ids make re-ingestion idempotent, mirroring the
    connector's own session-write scheme.
    """
    entries: list[MemoryEntry] = []
    for event in events:
        text = _event_text(event)
        if not text:
            continue
        event_id = getattr(event, "id", "") or str(uuid.uuid4())
        entries.append(
            _entry(
                text,
                author=getattr(event, "author", None) or user_id,
                entry_id=f"{app_name}:{user_id}:{session_id}:{event_id}",
            )
        )
    if entries:
        await memory.add_memory(
            app_name=app_name,
            user_id=user_id,
            memories=entries,
            **_EPISODE_CLASS,  # FIXED episode class (spec §3 table)
        )
    return len(entries)


async def _after_agent_callback(callback_context) -> None:
    """Persist each turn's events to Flair after the agent responds."""
    invocation_context = callback_context._invocation_context
    service = invocation_context.memory_service
    if not isinstance(service, FlairMemoryService):
        return  # no Flair wired (e.g. bare `adk web` without the URI) — skip
    session = invocation_context.session
    await persist_session_episodes(
        service,
        app_name=session.app_name,
        user_id=session.user_id,
        session_id=session.id,
        events=session.events or [],
    )


# ─── The agent ───────────────────────────────────────────────────────────────
# The tools list IS the write-surface allowlist (Sherlock hard requirement):
# two fixed-class write helpers plus read-only memory tools. Nothing here can
# write a soul record, workspace state, an org event, or a raw memory row
# with caller-chosen flags.

root_agent = Agent(
    model=MODEL,
    name="team_concierge",
    description=(
        "Front-office concierge for the team: records decisions and context "
        "into Flair so every agent on the team can retrieve them."
    ),
    instruction=(
        "You are the Team Concierge. Teammates talk to you about ideas, "
        "decisions, PR context, and constraints; your job is to commit the "
        "durable knowledge to team memory and to answer from it.\n"
        "\n"
        "Recording rules:\n"
        "- When the user states a decision, constraint, or team-relevant "
        "context, call record_decision with ONE self-contained statement "
        "(include the why). Confirm what you recorded.\n"
        "- When the user shares a personal preference or context that only "
        "concerns them, call record_personal.\n"
        "- Never invent memory. To answer questions about prior decisions or "
        "context, use load_memory first and answer only from what it "
        "returns; say plainly when nothing is recorded.\n"
        "- If a statement is ambiguous between team and personal, ask which "
        "it is rather than guessing."
    ),
    tools=[record_decision, record_personal, load_memory, preload_memory],
    after_agent_callback=_after_agent_callback,
)
