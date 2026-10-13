"""Per-user long-term memory on AgentCore Memory (actorId = Cognito sub).

Before a report, recall the user's preferences and stack facts from earlier
reports; after it, record the exchange so the memory strategies can extract
new ones. Memory is best-effort: failures are logged and never fail a report."""

import logging
import os

from bedrock_agentcore.memory import MemoryClient

logger = logging.getLogger(__name__)

# Must match the strategy namespaces in infra/lib/agent-stack.ts
NAMESPACES = ("/actors/{actor_id}/preferences", "/actors/{actor_id}/facts")
TOP_K = 5

_client: MemoryClient | None = None


def _memory() -> tuple[MemoryClient, str] | None:
    global _client
    memory_id = os.environ.get("MEMORY_ID")
    if not memory_id:
        return None
    if _client is None:
        _client = MemoryClient(region_name=os.environ.get("AWS_REGION"))
    return _client, memory_id


def recall(user_id: str, query: str) -> list[str]:
    mem = _memory()
    if not mem:
        return []
    client, memory_id = mem
    found: list[str] = []
    for template in NAMESPACES:
        try:
            records = client.retrieve_memories(
                memory_id=memory_id,
                namespace=template.format(actor_id=user_id),
                query=query[:1000],
                top_k=TOP_K,
            )
        except Exception:  # noqa: BLE001 - memory must never fail a report
            logger.exception("Memory recall failed")
            continue
        for record in records:
            text = ((record.get("content") or {}).get("text") or "").strip()
            if text and text not in found:
                found.append(text)
    return found


def remember(user_id: str, session_id: str, brief: str, summary: str) -> None:
    mem = _memory()
    if not mem:
        return
    client, memory_id = mem
    try:
        client.create_event(
            memory_id=memory_id,
            actor_id=user_id,
            session_id=session_id,
            messages=[(brief, "USER"), (summary, "ASSISTANT")],
        )
    except Exception:  # noqa: BLE001
        logger.exception("Memory write failed")
