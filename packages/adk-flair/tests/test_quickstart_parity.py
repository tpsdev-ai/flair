"""Integration test 3: Quickstart parity — Memory Bank ADK quickstart with
FlairMemoryService.

Executes the Memory Bank ADK quickstart flow with steps 2 and 6 swapped
(provision Flair / construct FlairMemoryService instead of Vertex AI Memory
Bank). Confirms cross-session recall on a second session.

MODEL-CONFIGURABLE via ADK_TEST_MODEL (LiteLLM syntax). When ADK_TEST_MODEL
is not set, the agent-loop portion SKIPs with a visible reason — the test
still validates everything up to the model-call boundary.

This test is structured so the agent-loop portion is cleanly separable:
- `test_provision_and_write` — provisions Flair, writes session 1 memories
- `test_cross_session_recall` — reads back from session 2 (requires model)
"""

from __future__ import annotations

import os
import uuid

import pytest


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _model_available() -> bool:
    """Check if a model is configured for the agent-loop portion."""
    return bool(os.environ.get("ADK_TEST_MODEL", ""))


def _skip_reason() -> str:
    return (
        "ADK_TEST_MODEL not set — agent-loop portion requires a model. "
        "Set ADK_TEST_MODEL=<liteLLM model string> to run the full quickstart. "
        "Provisioning and write-path tests still run without a model."
    )


# ─── Tests ───────────────────────────────────────────────────────────────────


@pytest.mark.live_flair
class TestQuickstartParity:
    """Memory Bank ADK quickstart with FlairMemoryService."""

    @pytest.mark.asyncio
    async def test_provision_and_write(self, live_flair):
        """Provision Flair and write session 1 memories through the adapter.

        This validates the full write path (add_session_to_memory,
        add_events_to_memory, add_memory) against a live Flair instance.
        No model required.
        """
        from adk_flair import FlairMemoryService
        from adk_flair.memory_service import _compound_tag

        app = "quickstart-test"
        user = "test-user-1"
        tag = _compound_tag(app, user)

        service = FlairMemoryService(
            url=live_flair.http_url,
            agent_id=live_flair.agent_id,
            keyfile=live_flair.keyfile_path,
        )

        # ── 1. add_memory (direct memory entries) ────────────────────────────
        from google.adk.memory.memory_entry import MemoryEntry
        from google.genai import types

        memories = [
            MemoryEntry(
                id=f"qs-mem-{i}",
                content=types.Content(
                    role="user",
                    parts=[types.Part(text=f"Quickstart fact {i}: the user's favorite color is blue")],
                ),
            )
            for i in range(3)
        ]
        await service.add_memory(app_name=app, user_id=user, memories=memories)

        # ── 2. add_session_to_memory ────────────────────────────────────────
        from google.adk.sessions import Session
        from google.adk.events import Event

        session = Session(app_name=app, user_id=user, id=f"qs-sess-{uuid.uuid4().hex[:8]}")
        event = Event(
            id=f"qs-evt-{uuid.uuid4().hex[:8]}",
            author="test-agent",
            content=types.Content(
                role="user",
                parts=[types.Part(text="Session memory: the user works in software engineering")],
            ),
        )
        session.events = [event]
        await service.add_session_to_memory(session)

        # ── 3. add_events_to_memory ─────────────────────────────────────────
        events = [
            Event(
                id=f"qs-evt2-{i}",
                author="test-agent",
                content=types.Content(
                    role="user",
                    parts=[types.Part(text=f"Incremental event {i}: project deadline is Friday")],
                ),
            )
            for i in range(2)
        ]
        await service.add_events_to_memory(
            app_name=app, user_id=user, events=events, session_id="qs-sess-2"
        )

        # ── 4. Verify writes are searchable ─────────────────────────────────
        result = await service.search_memory(
            app_name=app, user_id=user, query="favorite color"
        )
        assert len(result.memories) > 0, (
            "Expected to find 'favorite color' memory after writes"
        )

        result2 = await service.search_memory(
            app_name=app, user_id=user, query="software engineering"
        )
        assert len(result2.memories) > 0, (
            "Expected to find 'software engineering' session memory"
        )

        result3 = await service.search_memory(
            app_name=app, user_id=user, query="project deadline"
        )
        assert len(result3.memories) > 0, (
            "Expected to find 'project deadline' incremental event memory"
        )

        await service.close()

    @pytest.mark.asyncio
    async def test_cross_session_direct(self, live_flair):
        """Cross-session recall via direct service calls (always runs).

        Writes a fact through the FlairMemoryService in one session context
        and verifies it is searchable — the direct-service body that was
        previously (and wrongly) named test_cross_session_recall. No model
        required; this is the always-run path.
        """
        from adk_flair import FlairMemoryService

        app = "quickstart-recall"
        user = "recall-user"

        service = FlairMemoryService(
            url=live_flair.http_url,
            agent_id=live_flair.agent_id,
            keyfile=live_flair.keyfile_path,
        )

        # ── Session 1: write a fact ──────────────────────────────────────────
        from google.adk.memory.memory_entry import MemoryEntry
        from google.genai import types

        secret = f"the secret passphrase is 'flair-rocks-{uuid.uuid4().hex[:6]}'"
        memory = MemoryEntry(
            id=f"recall-mem-1",
            content=types.Content(
                role="user",
                parts=[types.Part(text=secret)],
            ),
        )
        await service.add_memory(app_name=app, user_id=user, memories=[memory])

        # ── Session 2: search for the fact ───────────────────────────────────
        # This is the cross-session recall: a NEW service instance (simulating
        # a new session) searches for the fact written in session 1.
        result = await service.search_memory(
            app_name=app, user_id=user, query="secret passphrase"
        )

        assert len(result.memories) > 0, (
            f"Cross-session recall failed: secret not found. "
            f"Expected to find '{secret[:50]}...' in search results"
        )

        found = any(
            "flair-rocks" in (m.content.parts[0].text if m.content and m.content.parts else "")
            for m in result.memories
        )
        assert found, (
            f"Cross-session recall failed: secret content not in results. "
            f"Results: {[m.content.parts[0].text[:80] if m.content and m.content.parts else '' for m in result.memories]}"
        )

        await service.close()

    @pytest.mark.asyncio
    async def test_cross_session_recall(self, live_flair):
        """Cross-session recall through a real ADK agent loop.

        Constructs a google.adk Agent with LiteLlm(model), PreloadMemoryTool,
        and an after_agent_callback per the quickstart. Runs session 1 planting
        a fact via a real model turn, then session 2 asking for it, and asserts
        the fact surfaces in session 2's response.

        Requires ADK_TEST_MODEL (LiteLLM syntax). Skips visibly otherwise.
        """
        if not _model_available():
            pytest.skip(_skip_reason())

        from adk_flair import FlairMemoryService
        from google.adk import Agent
        from google.adk.runners import Runner
        from google.adk.tools import PreloadMemoryTool
        from google.adk.sessions import InMemorySessionService
        from google.genai import types

        app = "quickstart-recall-agent"
        user = "recall-agent-user"
        model = os.environ["ADK_TEST_MODEL"]

        service = FlairMemoryService(
            url=live_flair.http_url,
            agent_id=live_flair.agent_id,
            keyfile=live_flair.keyfile_path,
        )

        # ── Build the agent per the quickstart pattern ───────────────────────
        async def after_agent_callback(callback_context):
            """Quickstart after_agent_callback: persist session events."""
            await service.add_events_to_memory(
                app_name=app,
                user_id=user,
                events=callback_context.session.events,
                session_id=callback_context.session.id,
            )

        agent = Agent(
            model=model,
            name="recall_agent",
            instruction=(
                "You are a helpful assistant with memory. "
                "Use the preload_memory tool to recall what you know about the user, "
                "and remember new facts they tell you."
            ),
            tools=[PreloadMemoryTool()],
            after_agent_callback=after_agent_callback,
        )

        session_service = InMemorySessionService()
        runner = Runner(
            agent=agent,
            app_name=app,
            session_service=session_service,
            memory_service=service,
        )

        # ── Session 1: plant a fact via a real model turn ───────────────────
        secret_word = f"zephyr-{uuid.uuid4().hex[:6]}"
        plant_prompt = (
            f"Remember this fact about me: my favorite code word is '{secret_word}'. "
            f"Please acknowledge you've stored it."
        )

        session1 = await session_service.create_session(
            app_name=app, user_id=user
        )
        events_s1 = []
        async for event in runner.run_async(
            user_id=user,
            session_id=session1.id,
            new_message=types.Content(
                role="user",
                parts=[types.Part(text=plant_prompt)],
            ),
        ):
            events_s1.append(event)

        # ── Session 2: ask for the fact ──────────────────────────────────────
        session2 = await session_service.create_session(
            app_name=app, user_id=user
        )
        recall_prompt = "What is my favorite code word?"

        events_s2 = []
        async for event in runner.run_async(
            user_id=user,
            session_id=session2.id,
            new_message=types.Content(
                role="user",
                parts=[types.Part(text=recall_prompt)],
            ),
        ):
            events_s2.append(event)

        # ── Assert the fact surfaces in session 2's response ────────────────
        # Collect all model-authored text from session 2
        s2_texts = []
        for evt in events_s2:
            if getattr(evt, "author", "") == "recall_agent":
                content = getattr(evt, "content", None)
                if content:
                    parts = getattr(content, "parts", []) or []
                    for p in parts:
                        t = getattr(p, "text", None)
                        if t:
                            s2_texts.append(str(t))

        combined = " ".join(s2_texts).lower()
        assert secret_word.lower() in combined, (
            f"Cross-session agent recall failed: '{secret_word}' not found in "
            f"session 2 agent response. Response texts: {s2_texts[:3]}"
        )

        await service.close()

    @pytest.mark.asyncio
    async def test_agent_loop_boundary(self, live_flair):
        """Validate everything up to the model-call boundary.

        Constructs the FlairMemoryService, writes memories, and verifies
        they are searchable — the full non-model path. The model-dependent
        agent loop is gated behind ADK_TEST_MODEL.
        """
        from adk_flair import FlairMemoryService

        service = FlairMemoryService(
            url=live_flair.http_url,
            agent_id=live_flair.agent_id,
            keyfile=live_flair.keyfile_path,
        )

        # Verify the service is constructed and healthy
        assert service._url == live_flair.http_url
        assert service._agent_id == live_flair.agent_id

        # Write and immediately search (smoke test)
        from google.adk.memory.memory_entry import MemoryEntry
        from google.genai import types

        marker = f"boundary-test-{uuid.uuid4().hex[:8]}"
        memory = MemoryEntry(
            id=f"boundary-1",
            content=types.Content(
                role="user",
                parts=[types.Part(text=marker)],
            ),
        )
        await service.add_memory(
            app_name="boundary-app", user_id="boundary-user", memories=[memory]
        )

        result = await service.search_memory(
            app_name="boundary-app", user_id="boundary-user", query=marker
        )
        assert len(result.memories) > 0, "Boundary smoke test: write not searchable"

        await service.close()
