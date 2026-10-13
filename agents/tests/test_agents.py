"""Offline tests: no AWS calls. Run from agents/:  python -m pytest tests"""

import os
import sys
from pathlib import Path
from unittest import mock

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC))
os.environ.setdefault("AWS_REGION", "eu-central-1")
os.environ.setdefault("AWS_DEFAULT_REGION", "eu-central-1")
os.environ.setdefault("KNOWLEDGE_BASE_ID", "KB123")

# advisor.py loads the catalog next to itself, as in the built package
CATALOG_SRC = Path(__file__).resolve().parents[2] / "lib" / "stack-optimizer" / "pricing-catalog.json"
(SRC / "pricing-catalog.json").write_bytes(CATALOG_SRC.read_bytes())

import advisor  # noqa: E402
import context_agent  # noqa: E402
import memory  # noqa: E402

INPUT = {
    "company": "Acme",
    "industry": "Retail",
    "region": "EU",
    "currency": "EUR",
    "priorities": ["cost", "sovereignty"],
    "horizonYears": 3,
    "notes": "",
    "documentNames": ["security-policy.pdf"],
    "components": [{"layer": "Relational Database", "component": "Heroku Postgres", "monthlyCost": 200, "details": ""}],
}


def test_brief_includes_stack_and_memory():
    brief = advisor.build_brief(INPUT, ["Prefers managed services"])
    assert "[0] Relational Database: Heroku Postgres | current cost 200 EUR/month" in brief
    assert "- Prefers managed services" in brief
    assert "EU data residency and sovereignty" in brief


def test_brief_asks_to_estimate_missing_costs():
    inp = {**INPUT, "components": [{"layer": "Cache", "component": "Redis Cloud", "monthlyCost": None, "details": ""}]}
    assert "[0] Cache: Redis Cloud | current cost not given (estimate it)" in advisor.build_brief(inp, [])


def test_pricing_tool_enum_matches_catalog():
    tools = {t.tool_name: t for t in advisor.make_tools("user-a", True)}
    schema = tools["get_reference_pricing"].tool_spec["inputSchema"]["json"]
    assert set(schema["properties"]["category"]["enum"]) == set(advisor.CATEGORIES)
    assert "functions" in tools["get_reference_pricing"](category="functions")


def test_search_context_without_documents_skips_retrieval():
    tools = {t.tool_name: t for t in advisor.make_tools("user-a", False)}
    with mock.patch.object(context_agent, "ask_context_agent") as ask:
        assert "No context documents" in tools["search_context"](question="data residency?")
        ask.assert_not_called()


def test_search_context_passes_trusted_user_id():
    tools = {t.tool_name: t for t in advisor.make_tools("user-a", True)}
    with mock.patch.object(advisor, "ask_context_agent", return_value="ok") as ask:
        tools["search_context"](question="data residency?")
        ask.assert_called_once_with("user-a", "data residency?")


def test_retrieval_is_filtered_to_user_and_cites_files():
    fake = {
        "retrievalResults": [
            {"content": {"text": "EU only"}, "location": {"s3Location": {"uri": "s3://b/users/u/1/security%20policy.pdf"}}},
            {"content": {"text": "99.9% SLA"}, "location": {"s3Location": {"uri": "s3://b/users/u/1/security%20policy.pdf"}}},
            {"content": {"text": ""}, "location": {}},
        ]
    }
    with mock.patch.object(context_agent._kb_runtime, "retrieve", return_value=fake) as retrieve:
        passages = context_agent.retrieve_passages("user-a", "residency")
    flt = retrieve.call_args.kwargs["retrievalConfiguration"]["vectorSearchConfiguration"]["filter"]
    assert flt == {"equals": {"key": "user_id", "value": "user-a"}}
    assert [p["id"] for p in passages] == ["security policy.pdf#1", "security policy.pdf#2"]


def test_memory_uses_exact_per_user_namespaces():
    client = mock.Mock()
    client.retrieve_memories.return_value = [{"content": {"text": "Prefers EU"}}]
    with mock.patch.dict(os.environ, {"MEMORY_ID": "mem-1"}), mock.patch.object(memory, "_client", client):
        assert memory.recall("user-a", "stack") == ["Prefers EU"]
    namespaces = [c.kwargs["namespace"] for c in client.retrieve_memories.call_args_list]
    assert namespaces == ["/actors/user-a/preferences", "/actors/user-a/facts"]
    assert all("namespace_path" not in c.kwargs for c in client.retrieve_memories.call_args_list)


def test_memory_failures_do_not_raise():
    client = mock.Mock()
    client.retrieve_memories.side_effect = RuntimeError("boom")
    client.create_event.side_effect = RuntimeError("boom")
    with mock.patch.dict(os.environ, {"MEMORY_ID": "mem-1"}), mock.patch.object(memory, "_client", client):
        assert memory.recall("user-a", "q") == []
        memory.remember("user-a", "r1", "brief", "summary")
