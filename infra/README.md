# Stack Optimizer on AWS — infrastructure

AWS CDK (TypeScript) app for the Stack Optimizer, deployed entirely to **eu-central-1 (Frankfurt)**.
All settings live in [`lib/config.ts`](lib/config.ts).

## Target architecture

```
stack.t4tangerine.com (CloudFront + S3; same page as www.t4tangerine.com/stack, in app mode)
  │  sign-in: Cognito managed login (code flow + PKCE)
  ▼
API Gateway HTTP API ── Cognito JWT authorizer
  ├─ POST /uploads   → presigned S3 PUT (users/<sub>/...) + metadata sidecar
  │                      S3 → EventBridge → ingest Lambda → KB direct ingestion (tagged user_id)
  ├─ POST /autofill  → pre-fill the form from the files' text (Claude Haiku on Bedrock)
  ├─ POST /reports   → DynamoDB job (PENDING) → async worker Lambda
  └─ GET  /reports[/{id}]  (list / poll)
                          │ worker: wait for the report's files to be INDEXED,
                          ▼ InvokeAgentRuntime, compute totals, store COMPLETE
            AgentCore Runtime (Strands, Python 3.13, IAM auth)        agents/
              Stack Advisor ── Claude Opus on Bedrock (EU inference profile)
                ├─ search_context → Context Agent ── Bedrock KB Retrieve (filter user_id) + Claude Haiku
                ├─ get_reference_pricing (lib/stack-optimizer/pricing-catalog.json)
                └─ AgentCore Memory (per-user preferences and stack facts)
```

The `user_id` used for retrieval and memory comes from the worker's payload, which takes it from the
Cognito token. The model never chooses it, so one user's agent can't see another user's documents or memories.

| Stack | Status | Contents |
|---|---|---|
| `StackOptimizer-Auth` | ✅ this step | Cognito user pool (email sign-up, optional TOTP MFA), web app client, managed login domain |
| `StackOptimizer-Data` | ✅ this step | Uploads bucket (30-day expiry), reports table, S3 Vectors index, Bedrock Knowledge Base + S3 data source |
| `StackOptimizer-Agent` | ✅ | AgentCore Memory (actor-scoped namespaces) and AgentCore Runtime hosting both agents (direct code deploy from `agents/dist`) |
| `StackOptimizer-Api` | ✅ | HTTP API + Cognito authorizer; uploads, autofill, reports and worker Lambdas; EventBridge-driven KB ingestion |
| `StackOptimizer-Cert` | ✅ | HTTPS certificate for `stack.t4tangerine.com` (us-east-1, required by CloudFront; no data) |
| `StackOptimizer-Web` | ✅ | Private S3 bucket + CloudFront with security headers, serving `stack/index.html` and `app-config.json` |
| `StackOptimizer-Ops` | ✅ | Monthly budget with email alerts on `app=StackOptimizer` resources |

## One-time account setup

1. **Bedrock model access** (Bedrock console → Model access, region eu-central-1): request access to the
   Anthropic models and Amazon Titan Text Embeddings V2. Anthropic needs a one-time use-case form.
2. **Check the model IDs** in `lib/config.ts` match what your account can use:
   ```bash
   aws bedrock list-inference-profiles --region eu-central-1 \
     --query "inferenceProfileSummaries[?contains(inferenceProfileId,'anthropic')].inferenceProfileId"
   ```
3. **Bootstrap CDK** in the account and region:
   ```bash
   npx cdk bootstrap aws://<ACCOUNT_ID>/eu-central-1
   ```
4. **Activate the `app` cost allocation tag** (Billing → Cost allocation tags) after the first deploy,
   so the budget filter matches.

## Deploy

The agent package is built locally (Linux ARM64 wheels via [uv](https://docs.astral.sh/uv/), no Docker), then
CDK uploads it as the Runtime's code:

```bash
../agents/build.sh          # → agents/dist (rerun after changing agents/ or the pricing catalog)
cd infra
npm ci
npx cdk diff
npx cdk deploy --all -c alertEmail=you@example.com
```

## Custom domain (DNS at GoDaddy)

`stack.t4tangerine.com` needs two CNAME records in GoDaddy (DNS → Manage):

1. **Certificate validation**: deploy `StackOptimizer-Cert`. It waits until the certificate is validated.
   Get the record with
   `aws acm describe-certificate --region us-east-1 --certificate-arn <arn> --query "Certificate.DomainValidationOptions[0].ResourceRecord"`
   and add it (name without the trailing `.t4tangerine.com.`). Keep it; it also renews the certificate.
2. **The app**: after `StackOptimizer-Web` deploys, point `stack` at its `CloudFrontDomain` output.

## Try the API

Sign in through the managed login URL to get an ID token, then:

```bash
API=<ApiUrl output>; TOKEN=<id token>
# 1. Upload a context file (optional)
curl -s -X POST $API/uploads -H "authorization: $TOKEN" -H 'content-type: application/json' \
  -d '{"fileName":"policy.pdf","size":'$(stat -f%z policy.pdf)'}'        # → { key, uploadUrl, contentType }
curl -s -X PUT "<uploadUrl>" -H 'content-type: application/pdf' --data-binary @policy.pdf
# 2. Start a report (documents = keys from step 1)
curl -s -X POST $API/reports -H "authorization: $TOKEN" -H 'content-type: application/json' -d '{
  "company":"Acme","region":"EU","currency":"EUR","horizonYears":3,"priorities":["cost","sovereignty"],
  "components":[{"layer":"Relational Database","component":"Heroku Postgres","monthlyCost":200}],
  "documents":["<key>"]}'                                                 # → 202 { reportId }
# 3. Poll until status is COMPLETE or FAILED
curl -s $API/reports/<reportId> -H "authorization: $TOKEN"
```

Each user can start `limits.reportsPerUserPerDay` reports per 24 hours (see `lib/config.ts`).

## Tests

```bash
cd agents && uv run --python 3.13 --with pytest --with-requirements requirements.txt python -m pytest tests
```

Outputs include the user pool and client IDs, the managed login URL, the bucket and table names, and the
Knowledge Base, data source and Memory IDs that the next stacks consume.

## Validate without deploying

```bash
npx tsc --noEmit -p .          # infra and Lambda handlers
CDK_DEFAULT_ACCOUNT=123456789012 npx cdk synth -q   # needs agents/dist
```

## Data handling

- Context files live under `users/<cognito-sub>/` and expire after 30 days; the Knowledge Base data source
  deletes their vectors when files are removed (`dataDeletionPolicy: DELETE`).
- Retrieval is filtered by `user_id` metadata, so a user's agent only sees that user's documents. Uploads are
  ingested one by one (`IngestKnowledgeBaseDocuments`) and removed from the index when S3 deletes or expires them.
- Memory records live under `/actors/<cognito-sub>/...` and expire after `memoryRetentionDays`.
- User pool, bucket and table are retained on stack deletion, and the pool and table have deletion protection.
