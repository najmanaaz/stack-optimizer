"""AgentCore Runtime entrypoint for the Stack Optimizer agents.

Invoked only by the report worker Lambda (IAM auth) with an already-validated
payload: {"userId": <cognito sub>, "reportId": <uuid>, "input": {...}}.
Returns {"report": StackReport}."""

import logging

from bedrock_agentcore.runtime import BedrockAgentCoreApp

import memory
from advisor import build_brief, run_advisor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("stack_advisor")

app = BedrockAgentCoreApp()


def _memory_summary(inp: dict, report) -> str:
    picks = "; ".join(
        f"{inp['components'][l.input_index]['component']} -> {l.recommendation}"
        for l in report.layers
        if 0 <= l.input_index < len(inp["components"])
    )
    alignment = " ".join(f"{c.insight} ({c.source})" for c in report.context_alignment)
    return f"{report.executive_summary}\nRecommendations: {picks}\nContext: {alignment}"


@app.entrypoint
def invoke(payload: dict) -> dict:
    user_id = payload.get("userId")
    report_id = payload.get("reportId")
    inp = payload.get("input")
    if not user_id or not report_id or not isinstance(inp, dict) or not inp.get("components"):
        raise ValueError("userId, reportId and input.components are required")

    logger.info("Report %s started (%d components)", report_id, len(inp["components"]))
    memories = memory.recall(user_id, build_brief(inp, []))
    report = run_advisor(user_id, inp, memories)
    memory.remember(user_id, report_id, build_brief(inp, []), _memory_summary(inp, report))
    logger.info("Report %s finished", report_id)
    return {"report": report.model_dump()}


if __name__ == "__main__":
    app.run()
