"""adk-flair quickstart (Python) — cross-session recall with a real Gemini model.

Runs the Memory Bank ADK quickstart flow against Flair instead of Vertex AI
Memory Bank:

  1. Build a minimal ADK agent (Gemini via LiteLLM) with FlairMemoryService as
     its memory.
  2. Session 1 — the user tells the agent a fact; the after-agent callback
     persists the turn to Flair.
  3. SETTLE — poll search_memory until that fact is retrievable (bounded), so a
     freshly-booted Flair has finished indexing before we read back. This is the
     demo's reliability step; it does NOT change the adapter's production 2s
     search budget (a deliberate graceful-degradation design).
  4. Session 2 — a brand-new session asks for the fact; preload_memory pulls it
     from Flair and the agent answers. We print whether the fact was recalled.

─── Prerequisites (see README.md) ──────────────────────────────────────────
    npm i -g @tpsdev-ai/flair && flair init
    flair agent add my-adk-app          # writes ~/.flair/keys/my-adk-app.key
    pip install adk-flair litellm       # LiteLLM powers the Gemini model
    export FLAIR_URL=http://localhost:19926
    export FLAIR_AGENT_ID=my-adk-app
    export FLAIR_KEYFILE=~/.flair/keys/my-adk-app.key
    export GOOGLE_API_KEY=...           # or GEMINI_API_KEY

─── Run ─────────────────────────────────────────────────────────────────────
    python packages/adk-flair/examples/quickstart.py

Exit code: 0 = fact recalled, 2 = not recalled, 1 = setup/settle error.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid

APP_NAME = "adk-flair-quickstart-py"
# A fresh user id per run keeps the demo idempotent: session 1 and session 2
# share it (that's the cross-session recall), but re-running against the same
# Flair never accumulates conflicting facts under one user. Set FLAIR_DEMO_USER
# to pin a stable identity across runs instead.
USER_ID = os.environ.get("FLAIR_DEMO_USER", f"demo-user-{uuid.uuid4().hex[:8]}")
MODEL = os.environ.get("ADK_MODEL", "gemini/gemini-2.5-flash")  # LiteLLM syntax
SETTLE_BUDGET_S = 10.0


async def settle(memory, token: str, budget_s: float):
    """Poll search_memory until the token is retrievable. Returns poll count or None."""
    deadline = time.monotonic() + budget_s
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        res = await memory.search_memory(
            app_name=APP_NAME, user_id=USER_ID, query=token
        )
        for m in res.memories:
            text = m.content.parts[0].text if (m.content and m.content.parts) else ""
            if token.lower() in (text or "").lower():
                return attempt
        await asyncio.sleep(0.5)
    return None


async def run_turn(runner, session_id: str, text: str) -> str:
    """Run one agent turn and return all model-authored text concatenated."""
    from google.genai import types

    out: list[str] = []
    async for event in runner.run_async(
        user_id=USER_ID,
        session_id=session_id,
        new_message=types.Content(role="user", parts=[types.Part(text=text)]),
    ):
        if getattr(event, "author", "") == "quickstart_agent":
            content = getattr(event, "content", None)
            for p in (getattr(content, "parts", None) or []):
                t = getattr(p, "text", None)
                if t:
                    out.append(str(t))
    return " ".join(out).strip()


async def main() -> int:
    url = os.environ.get("FLAIR_URL", "http://localhost:19926")
    agent_id = os.environ.get("FLAIR_AGENT_ID")
    keyfile = os.environ.get("FLAIR_KEYFILE")

    if not agent_id or not keyfile:
        print(
            "Set FLAIR_AGENT_ID and FLAIR_KEYFILE first (see the README quickstart). "
            "Provision them with `flair agent add <id>`.",
            file=sys.stderr,
        )
        return 1
    if not os.environ.get("GOOGLE_API_KEY") and not os.environ.get("GEMINI_API_KEY"):
        print(
            "Set GOOGLE_API_KEY (or GEMINI_API_KEY) to a Gemini API key to run the agent.",
            file=sys.stderr,
        )
        return 1

    from adk_flair import FlairMemoryService
    from google.adk import Agent
    from google.adk.runners import Runner
    from google.adk.tools import preload_memory
    from google.adk.sessions import InMemorySessionService

    try:
        from google.adk.models.lite_llm import LiteLlm
    except ImportError:
        print(
            "This example uses LiteLLM for the Gemini model — run `pip install litellm`.",
            file=sys.stderr,
        )
        return 1

    memory = FlairMemoryService(url=url, agent_id=agent_id, keyfile=keyfile)

    async def after_agent_callback(callback_context):
        """Persist each turn's events to Flair after the agent responds."""
        await memory.add_events_to_memory(
            app_name=APP_NAME,
            user_id=USER_ID,
            events=callback_context.session.events,
            session_id=callback_context.session.id,
        )

    agent = Agent(
        model=LiteLlm(model=MODEL),
        name="quickstart_agent",
        instruction=(
            "You are a helpful assistant with long-term memory. Use the "
            "preload_memory tool to recall what you know about the user, and "
            "remember new facts they tell you."
        ),
        tools=[preload_memory],
        after_agent_callback=after_agent_callback,
    )

    session_service = InMemorySessionService()
    runner = Runner(
        agent=agent,
        app_name=APP_NAME,
        session_service=session_service,
        memory_service=memory,
    )

    print(f"adk-flair quickstart (Python) — Flair={url} model={MODEL} user={USER_ID}")

    # ── Session 1: plant a fact ──────────────────────────────────────────────
    token = f"zephyr-{uuid.uuid4().hex[:8]}"
    session1 = await session_service.create_session(app_name=APP_NAME, user_id=USER_ID)
    print(f"\n[session 1] planting fact: favorite code word = '{token}'")
    a1 = await run_turn(
        runner,
        session1.id,
        f"Remember this about me: my favorite code word is '{token}'. "
        f"Acknowledge that you've stored it.",
    )
    print(f"[session 1] agent: {a1}")

    # ── Settle: wait until the fact is retrievable on this (possibly cold) Flair
    print("\n[settle] waiting for the fact to become searchable...")
    polls = await settle(memory, token, SETTLE_BUDGET_S)
    if polls is None:
        print(
            f"[settle] TIMED OUT after {SETTLE_BUDGET_S:.0f}s — the fact never "
            f"became searchable. Is Flair indexing? Is FLAIR_URL correct?",
            file=sys.stderr,
        )
        await memory.close()
        return 1
    print(f"[settle] fact searchable after {polls} poll(s)")

    # ── Session 2: recall in a brand-new session ─────────────────────────────
    session2 = await session_service.create_session(app_name=APP_NAME, user_id=USER_ID)
    print("\n[session 2] asking: What is my favorite code word?")
    a2 = await run_turn(runner, session2.id, "What is my favorite code word?")
    print(f"[session 2] agent: {a2}")

    recalled = token.lower() in a2.lower()
    print(
        f"\nRECALLED: {'yes' if recalled else 'no'} (planted '{token}', "
        f"{'found' if recalled else 'not found'} in the session-2 answer)"
    )

    await memory.close()
    return 0 if recalled else 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
