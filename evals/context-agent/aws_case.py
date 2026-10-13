"""Run one question through the AWS Context Agent (agents/src/context_agent.py):
Bedrock Knowledge Base retrieval filtered to the eval tenant, then the context
model on Bedrock. Reads {"user_id", "question"} as JSON on stdin and prints
{"text", "passages", "model", "usage", "stop_reason", "system_prompt"}.

Needs AWS credentials (AWS_PROFILE) plus KNOWLEDGE_BASE_ID and CONTEXT_MODEL_ID,
which run-eval.mjs sets."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "agents", "src"))

import context_agent  # noqa: E402


def main() -> None:
    req = json.load(sys.stdin)
    out = context_agent.ask_context_agent_detailed(req["user_id"], req["question"])
    out["system_prompt"] = context_agent.SYSTEM_PROMPT
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
