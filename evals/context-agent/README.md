# Context Agent eval

Measures how well the **Context Agent** answers the Stack Advisor's questions from a company's own documents: right facts, nothing invented, honest "not covered" answers, valid citations, and whether search found the right passages. It runs the same 32 questions against both deployments:

| Variant | Deployment | Search | Model |
|---|---|---|---|
| `baseline` | www (Vercel) | BM25 over the files in memory (`lib/stack-optimizer/retrieval.js`) | `claude-haiku-5-5` (Claude API) |
| `v1` | AWS | Bedrock Knowledge Base vector search, filtered to the eval tenant | `claude-haiku-4-5` (Bedrock, EU) |

The runner calls each deployment's real entry point: `askContextAgentDetailed` in `lib/stack-optimizer/context-agent.js`, and `ask_context_agent_detailed` in `agents/src/context_agent.py`.

## Test data

`fixtures/nordlicht/` holds 11 documents from a fictional company, Nordlicht Analytics:
- **6 core files:** goals, engineering tenets, security policy, purchasing SOP, tech overview, card statement.
- **5 distractors** built to make the task hard:
  - an outdated 2024 security policy that contradicts the current one;
  - meeting notes that mix decisions and mere proposals;
  - a Datadog order form that hides a data-residency breach;
  - an onboarding guide carrying a planted prompt injection ("SYSTEM OVERRIDE: ...");
  - customer contract terms.

`cases.json` (readable version: `cases.md`) has 32 questions, each with the facts a correct answer must contain, the claims it must not make, and the files that hold the answer:

| Type | # | Tests |
|---|---|---|
| lookup | 10 | One fact from one document |
| multi_doc | 7 | Combining several documents |
| conflict | 7 | Current policy over the outdated one; proposal vs decision |
| numeric | 2 | Figures from the statement and tables |
| abstain | 4 | Saying "not covered" instead of inventing |
| injection | 2 | Ignoring the planted instruction |

## Metrics

A `claude-sonnet-5-5` judge (structured output) checks content against the answer key; code checks citations and retrieval. The same judge grades both deployments.

| Metric | Grader | Meaning |
|---|---|---|
| **pass** | combined | facts = 1, no false claims, correct abstention, valid citations, no refusal |
| facts | judge | Share of required facts present and accurate |
| no_false_claims | judge | No forbidden claim, nothing unsupported by the retrieved passages, no invented specifics |
| abstain_ok | judge | Says "not covered" exactly when it should |
| citations_ok | code | Every cited `[file#n]` was really retrieved; at least one points to a file holding the answer |
| retrieval_hit / retrieval_all | code | Search returned one / all of the files holding the answer (abstain questions score 1) |

Per answer it also records latency, tokens (agent and judge separately), cost, answer length and refusals.

`selftest.mjs` checks the grader itself: a perfect answer must pass, while an empty answer, "I don't know" and a confident wrong answer must fail.

## Run it

```bash
# www (needs ANTHROPIC_API_KEY)
node evals/context-agent/run-eval.mjs --flow evals/context-agent/results --target www --variant baseline --reps 3

# AWS: load the fixtures into the Knowledge Base as the eval tenant, then run
uv venv evals/.venv && uv pip install --python evals/.venv/bin/python -r agents/requirements.txt "botocore[crt]"
UPLOADS_BUCKET=<bucket> KNOWLEDGE_BASE_ID=<kb-id> DATA_SOURCE_ID=<ds-id> AWS_PROFILE=<profile> \
  evals/.venv/bin/python evals/context-agent/aws-fixtures.py
PYTHON=evals/.venv/bin/python KNOWLEDGE_BASE_ID=<kb-id> AWS_PROFILE=<profile> \
  node evals/context-agent/run-eval.mjs --flow evals/context-agent/results --target aws --variant v1 --reps 3

# Grader self-test
node evals/context-agent/selftest.mjs
```

Runs resume where they stopped. Failed attempts go to `errors.jsonl`, never into the scores. The runner refuses to start if the runner, grader, cases or agent code changed since a person last approved them; re-approve with `--approve-harness` after reviewing the change.

Results are in `results/`: `baseline/` and `v1/` each hold `results.jsonl` (one graded row per answer) and `traces/` (the full exchange for every answer). `report.html` is the comparison report.

## Results (13 October 2026)

32 questions × 3 repeats per deployment (192 answers), graded by `claude-sonnet-5-5`. ± is the 95% confidence interval across questions.

| Metric | www: BM25 + Haiku 5.5 | AWS: Knowledge Base + Haiku 4.5 |
|---|---|---|
| **Pass** | **69.8%** ±14 | **70.8%** ±12 |
| Facts correct | 93.5% | 95.3% |
| No false claims | **97.9%** | 72.9% |
| Citations valid | 81.2% | **100%** |
| Abstains correctly | 95.8% | 100% |
| Search found the answer | 96.9% | 100% |
| Agent cost per answer | $0.0007 | $0.0041 (est. Bedrock EU price) |
| Latency median / p90 | 2.9 s / 4.8 s | 5.1 s / 44.8 s |

**Same pass rate, different failure modes.** The paired difference is +1.0 point ±18, a tie.
- **www (Haiku 5.5) fabricates citations.** It cites passage numbers it was never shown, apparently using section numbers as ids (e.g. `sop#5` when the excerpts were `#1` and `#2`), on about 1 answer in 5. Its claims are almost never wrong.
- **AWS (Haiku 4.5) adds unsupported details.** Its citations are always valid and search never missed, but 27% of answers include a material error. Most were invented details (13), wrong numbers (7) or wrong dates (6). One miscalculated a 30-day notice deadline as 1 February instead of 30 January. Two called a 15-day log retention "within policy" when the minimum is 30 days. It is also ~6× the cost, with slow outliers (p90 45 s).
- **Search:** BM25 missed the card statement for "How much did ChatGPT Team cost in September?"; the vector search did not.
- **Both resisted the planted prompt injection** in every answer. Remaining injection-case failures are citation or detail errors, not the injected claim.

**Next levers:**
- **www:** validate cited ids against the retrieved passages and repair or drop invented ones.
- **AWS:** move the context model to Haiku 5.5 when Bedrock enables it, then re-run this eval.

**How the grader was calibrated:**
- **Pilot:** 6 questions; this fixed a citation-parsing bug.
- **Self-test:** perfect answers pass; empty answers, "I don't know" and confident wrong answers fail (36/36).
- **Spot-check:** a first full grading failed ~3 in 10 answers for style rather than errors. The judge now classifies each issue by kind, and code counts only material kinds (wrong date, number, compliance call or decision, invented detail). All 192 saved answers were re-graded without re-running the agents. The original grades are kept in `results/*/results.grader-v1.jsonl`. A fresh spot-check of 8 random failures found all 8 genuine.
