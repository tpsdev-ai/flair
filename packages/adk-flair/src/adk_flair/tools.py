"""Pre-built ADK agent tools for Flair memory (flair#1331).

``create_flair_tools()`` returns ready-to-use async tool functions —
``store_memory`` / ``search_memory`` / ``list_memories`` — bound to ONE
FlairMemoryService instance and ONE app+user scope.

Explicit injection only. There is deliberately no environment-variable
discovery, no ADK service-registry lookup, no module-level singleton and no
ambient fallback of any kind: the service and scope a tool acts on are visible
at the call site that created it, so the wiring is auditable. ``app_name`` and
``user_id`` bind at FACTORY time, not per tool call — memory scope is
application wiring, not something the model chooses. A tool signature that
exposed ``user_id`` to the LLM would let a prompted model read or write
another user's memories.

The returned functions are plain async callables with type hints and
docstrings. google-adk accepts bare callables in ``LlmAgent(tools=[...])``
(``ToolUnion = Union[Callable, BaseTool, BaseToolset]``) and wraps each in a
``FunctionTool`` automatically, generating the Gemini function declaration
from the signature and docstring — no manual wrapping needed. Wrapping them
yourself (``FunctionTool(tool)``) works too and produces the same declaration.

Usage:
    from google.adk.agents import LlmAgent
    from adk_flair import FlairMemoryService, create_flair_tools

    memory_service = FlairMemoryService()
    agent = LlmAgent(
        model="gemini-2.5-flash",
        name="assistant",
        instruction="...",
        tools=create_flair_tools(
            memory_service, app_name="my-app", user_id="user-123"
        ),
    )

Design notes:
  - ``tags`` on ``store_memory`` are stored INSIDE the memory's
    ``custom_metadata`` blob under the key ``"tags"`` (the explicit param is
    authoritative over a blob ``"tags"`` key, mirroring the ``subject``
    precedence rule). They are descriptive labels with no server-side effect.
    They are deliberately NOT written into the record's top-level ``tags``
    array: that array is adk-flair's per-user scope boundary (the compound
    ``adk:<app>:<user>`` tag), and a model-supplied value landing there could
    forge another scope's tag.
  - Tool return values are plain JSON-serializable dicts. Failures the model
    can act on come back as ``{"error": "..."}`` — the shape ADK itself uses
    for tool-level errors — rather than raised exceptions, so one bad call
    degrades into a self-correctable message instead of aborting the run.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

import httpx

from google.adk.memory.memory_entry import MemoryEntry
from google.genai import types

from adk_flair.memory_service import FlairMemoryService

logger = logging.getLogger("adk_flair")

__all__ = ["create_flair_tools"]


def _entry_to_dict(entry: MemoryEntry) -> Dict[str, Any]:
    """Map a MemoryEntry onto the plain JSON-serializable dict the tools return.

    ``subject`` is hoisted to the top level (from ``custom_metadata["subject"]``,
    where the read path surfaces the record's subject column) so the round-trip
    is symmetric with ``store_memory(subject=...)``. The full ``custom_metadata``
    dict is included unchanged alongside it.
    """
    text = FlairMemoryService._extract_content_text(entry.content) or ""
    metadata = dict(entry.custom_metadata or {})
    return {
        "id": entry.id,
        "subject": metadata.get("subject"),
        "content": text,
        "author": entry.author,
        "timestamp": entry.timestamp,
        "custom_metadata": metadata,
    }


def create_flair_tools(
    memory_service: FlairMemoryService,
    *,
    app_name: str,
    user_id: str,
) -> list:
    """Create the pre-built Flair memory tools for one ADK agent.

    Returns ``[store_memory, search_memory, list_memories]`` — async functions
    bound to ``memory_service`` and to the ``app_name``/``user_id`` scope given
    here. Pass the list straight to ``LlmAgent(tools=...)``; ADK wraps bare
    callables in ``FunctionTool`` automatically.

    The scope binds at factory time on purpose: which user's memory a tool
    touches is decided by the application when it wires the agent, never by
    the model at call time. Create one tool set per (service, app, user)
    scope — e.g. per session — rather than sharing one set across users.

    Args:
        memory_service: The FlairMemoryService instance the tools delegate to.
            Explicit injection only — the factory never discovers a service
            from the environment or a registry.
        app_name: ADK app name the memories are scoped to (required,
            non-empty).
        user_id: User id the memories are scoped to (required, non-empty).

    Returns:
        list of three async tool callables, in the order
        ``[store_memory, search_memory, list_memories]``.

    Raises:
        TypeError: memory_service is not a FlairMemoryService.
        ValueError: empty ``app_name`` or ``user_id`` — a scope mistake must
            fail at wiring time, not at the first tool call.
    """
    if not isinstance(memory_service, FlairMemoryService):
        raise TypeError(
            "memory_service must be a FlairMemoryService instance "
            f"(got: {type(memory_service).__name__}) — construct one and pass "
            "it in; the tools never discover a service ambiently"
        )
    if not app_name or not isinstance(app_name, str):
        raise ValueError(
            "app_name is required and must be a non-empty string — the tools "
            "bind their memory scope at creation time"
        )
    if not user_id or not isinstance(user_id, str):
        raise ValueError(
            "user_id is required and must be a non-empty string — the tools "
            "bind their memory scope at creation time"
        )

    async def store_memory(
        subject: str,
        description: str,
        tags: Optional[list[str]] = None,
        custom_metadata: Optional[dict] = None,
    ) -> dict:
        """Save a memory to the user's long-term memory store.

        Use this when the conversation surfaces information worth remembering
        across sessions — preferences, decisions, facts about the user, or
        anything the user asks to have remembered. Storing the same
        description again updates the existing memory rather than creating a
        duplicate.

        Args:
            subject: Short human-readable title for the memory, a few words
                up to 512 characters. Example: "Preferred airline seat".
            description: The full text of the memory — state the fact so it
                is understandable on its own when read back later.
            tags: Optional short labels categorizing the memory, for example
                ["travel", "preference"]. Returned with the memory on later
                search and list calls.
            custom_metadata: Optional dictionary of structured attributes to
                store alongside the memory, for example {"source": "chat"}.
                Stored and returned verbatim; keys have no effect on how the
                memory is stored.

        Returns:
            On success a dict {"status": "stored", "subject": <subject>}.
            On failure a dict {"error": <what went wrong and how to fix it>}.
        """
        if not description or not description.strip():
            return {
                "error": "description must be non-empty — provide the text "
                "of the memory to store"
            }

        metadata: Optional[Dict[str, Any]] = (
            dict(custom_metadata) if custom_metadata is not None else None
        )
        if tags is not None:
            # Explicit param authoritative over a blob "tags" key (same rule
            # as subject). Never mutates the caller's dict — copied above.
            if metadata is None:
                metadata = {}
            metadata["tags"] = list(tags)

        entry = MemoryEntry(
            content=types.Content(
                role="user", parts=[types.Part(text=description)]
            )
        )
        try:
            await memory_service.add_memory(
                app_name=app_name,
                user_id=user_id,
                memories=[entry],
                custom_metadata=metadata,
                subject=subject,
            )
        except ValueError as exc:
            # Validation (metadata caps, over-long subject): surface the
            # actionable message so the model can shrink the payload & retry.
            return {"error": str(exc)}
        return {"status": "stored", "subject": subject}

    async def search_memory(query: str, limit: int = 5) -> dict:
        """Search the user's long-term memories by meaning.

        Use this to recall previously stored information relevant to the
        current conversation. Matching is semantic, so a natural-language
        description of what you are looking for works better than bare
        keywords.

        Args:
            query: What to look for, in natural language. Example: "the
                user's dietary restrictions".
            limit: Maximum number of memories to return. Default 5; values
                above 20 still return at most 20.

        Returns:
            A dict {"count": <n>, "memories": [...]} where each memory has
            "subject", "content", "author", "timestamp" and
            "custom_metadata" fields, most relevant first. count 0 with an
            empty list means nothing relevant was found (or the memory store
            was unreachable).
        """
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            return {"error": f"limit must be a positive integer (got: {limit!r})"}
        response = await memory_service.search_memory(
            app_name=app_name, user_id=user_id, query=query
        )
        memories = [_entry_to_dict(m) for m in response.memories[:limit]]
        return {"count": len(memories), "memories": memories}

    async def list_memories(limit: int = 20, offset: int = 0) -> dict:
        """List the user's stored memories, newest first.

        Use this to browse or review what is currently remembered when there
        is no specific query to search with — for example to summarize stored
        memories or check whether something was already saved.

        Args:
            limit: Page size — how many memories to return. Default 20,
                maximum 200.
            offset: How many of the newest memories to skip, for paging
                through older ones. Default 0.

        Returns:
            A dict {"count": <n>, "offset": <offset>, "memories": [...]}
            where each memory has "subject", "content", "author",
            "timestamp" and "custom_metadata" fields. On failure returns
            {"error": "..."} — for example when the memory store is
            unreachable.
        """
        try:
            entries = await memory_service.list_memories(
                app_name=app_name, user_id=user_id, limit=limit, offset=offset
            )
        except ValueError as exc:
            return {"error": str(exc)}
        except (httpx.HTTPError, RuntimeError) as exc:
            # list_memories propagates transport failures by contract (a
            # browsing API must distinguish "no memories" from "Flair is
            # down") — but a tool must hand the model a message, not a
            # traceback.
            logger.warning(
                "adk-flair: list_memories tool call failed (app=%s): %s",
                app_name, exc,
            )
            return {
                "error": "memory store request failed "
                f"({type(exc).__name__}: {exc}) — the memory store may be "
                "unreachable; try again later"
            }
        memories = [_entry_to_dict(e) for e in entries]
        return {"count": len(memories), "offset": offset, "memories": memories}

    return [store_memory, search_memory, list_memories]
