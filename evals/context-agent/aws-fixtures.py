"""Load the eval fixtures into the AWS Knowledge Base as a dedicated test tenant.

Uploads every file in fixtures/nordlicht/ the way the app does it
(users/<user_id>/<fixed-uuid>/<name> plus the user_id metadata sidecar); the
bucket's EventBridge rule then triggers the ingest Lambda. Waits until every
document is INDEXED. Safe to re-run: uploads overwrite the same keys, which
also restarts the bucket's 30-day expiry (re-run before each AWS eval if more
than ~25 days have passed).

    UPLOADS_BUCKET=... KNOWLEDGE_BASE_ID=... DATA_SOURCE_ID=... AWS_PROFILE=... \
      python evals/context-agent/aws-fixtures.py
"""

import json
import os
import sys
import time

import boto3

REGION = "eu-central-1"
BUCKET = os.environ["UPLOADS_BUCKET"]
KB_ID = os.environ["KNOWLEDGE_BASE_ID"]
DATA_SOURCE_ID = os.environ["DATA_SOURCE_ID"]
USER_ID = "00000000-0000-4000-8000-00000000e7a1"  # must match AWS_EVAL_USER in run-eval.mjs
UPLOAD_ID = "e7a1e7a1-0000-4000-8000-c0de00000001"  # fixed, so re-runs overwrite
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "nordlicht")


def main() -> None:
    s3 = boto3.client("s3", region_name=REGION)
    agent = boto3.client("bedrock-agent", region_name=REGION)
    uris = []
    for name in sorted(os.listdir(FIXTURES)):
        key = f"users/{USER_ID}/{UPLOAD_ID}/{name}"
        # Sidecar first: the ingest Lambda reads it when the file lands
        s3.put_object(Bucket=BUCKET, Key=f"{key}.metadata.json",
                      Body=json.dumps({"metadataAttributes": {"user_id": USER_ID}}).encode(),
                      ContentType="application/json")
        with open(os.path.join(FIXTURES, name), "rb") as f:
            s3.put_object(Bucket=BUCKET, Key=key, Body=f.read())
        uris.append(f"s3://{BUCKET}/{key}")
        print(f"uploaded {name}")

    deadline = time.time() + 600
    while True:
        statuses = {}
        for i in range(0, len(uris), 10):
            try:
                res = agent.get_knowledge_base_documents(
                    knowledgeBaseId=KB_ID, dataSourceId=DATA_SOURCE_ID,
                    documentIdentifiers=[{"dataSourceType": "S3", "s3": {"uri": u}} for u in uris[i:i + 10]])
                for d in res["documentDetails"]:
                    statuses[d["identifier"]["s3"]["uri"]] = d["status"]
            except agent.exceptions.ResourceNotFoundException:
                pass
        indexed = sum(1 for u in uris if statuses.get(u) == "INDEXED")
        failed = [u for u in uris if statuses.get(u) in ("FAILED", "METADATA_UPDATE_FAILED")]
        print(f"{indexed}/{len(uris)} indexed")
        if failed:
            sys.exit(f"ingestion failed for: {', '.join(u.rsplit('/', 1)[-1] for u in failed)}")
        if indexed == len(uris):
            return
        if time.time() > deadline:
            sys.exit("timed out waiting for indexing")
        time.sleep(10)


if __name__ == "__main__":
    main()
