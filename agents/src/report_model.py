"""Structured report the Stack Advisor must return. Mirrors the submit_report
tool schema in api/stack-optimizer.js so both deployments produce the same shape;
totals and savings are computed downstream, not by the model."""

from typing import Literal

from pydantic import BaseModel, Field


class LayerRecommendation(BaseModel):
    input_index: int = Field(description="Index of the component in the input list.")
    current_monthly_cost: float = Field(
        description="What the company pays for this component today, per month, in the client's currency. Use the cost given in the input; if it says 'not given', estimate it from the product's public list price for a typical plan at the company's apparent size."
    )
    cloud_comparison: bool = Field(
        description="true if AWS or Google Cloud could run this instead (hosting, servers, databases, storage, networking, login, monitoring, data, AI APIs, build pipelines). false for business software they don't replace, such as chat, video calls, design, documents, project tracking or password managers."
    )
    aws_services: str = Field(description="Recommended AWS service(s), each followed by what it is in a few plain words and a plain size, e.g. 'Amazon RDS (managed database), small'. Empty when cloud_comparison is false or the client's policies rule this cloud out.")
    aws_monthly_cost: float = Field(description="Estimated monthly cost on AWS, in the client's currency.")
    gcp_services: str = Field(description="Recommended Google Cloud service(s), each followed by what it is in a few plain words and a plain size, e.g. 'Cloud SQL (managed database), small'. Empty when cloud_comparison is false or the client's policies rule this cloud out.")
    gcp_monthly_cost: float = Field(description="Estimated monthly cost on GCP, in the client's currency.")
    recommendation: Literal["aws", "gcp", "keep", "cancel", "downgrade", "consolidate", "switch"] = Field(
        description="aws/gcp: move to that cloud (only if cloud_comparison). keep: no change. cancel: stop paying, it isn't needed. downgrade: fewer seats or a cheaper plan of the same product. consolidate: drop it because another tool the company already pays for does the job. switch: move to a cheaper equivalent product."
    )
    alternative: str = Field(
        description="For downgrade, consolidate or switch: what to do instead, in plain words, e.g. 'Use Google Meet recordings, already included in Google Workspace'. Empty otherwise."
    )
    alternative_monthly_cost: float = Field(
        description="Monthly cost of this item after a cancel, downgrade, consolidate or switch (0 when cancelled or consolidated into a tool already paid for). 0 for aws, gcp or keep."
    )
    rationale: str = Field(description="1-2 plain sentences on why this choice is best for this company.")
    migration_effort: Literal["low", "medium", "high"]
    one_time_migration_cost: float = Field(
        description="Estimated one-off migration cost (engineering time, dual-running, egress) in the client's currency. 0 if keep."
    )
    efficiency_gains: str = Field(description="Benefits beyond cost, in plain words: less maintenance work for the team, fewer outages, faster for users, easier to grow.")


class ContextInsight(BaseModel):
    insight: str = Field(description="In one plain sentence, how a rule or goal from the company's documents shaped the advice.")
    source: str = Field(description="Citation id(s) such as file#3, or 'general' if no document applies.")


class RoadmapPhase(BaseModel):
    phase: str
    timeframe: str
    actions: str


class StackReport(BaseModel):
    """The final stack optimisation report. One layers entry per input component."""

    executive_summary: str = Field(
        description="3-4 short, plain sentences for a technology executive: how much they can save, what to change, and why."
    )
    layers: list[LayerRecommendation]
    long_term_efficiency: list[str] = Field(
        description="4-6 further ways to save over time, each one plain sentence, e.g. commit to 1- or 3-year plans for discounts, switch to more efficient server types, turn off unused resources automatically, review bills monthly."
    )
    context_alignment: list[ContextInsight]
    risks: list[str] = Field(description="3-5 risks of making these changes, each with how to reduce it, in plain words.")
    roadmap: list[RoadmapPhase]
    assumptions: list[str]
