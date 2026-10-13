// Report worker (invoked asynchronously by reports.ts, no retries):
// 1. claim the PENDING job (conditional update, so a duplicate event is a no-op)
// 2. wait briefly for the report's context files to finish Knowledge Base ingestion
// 3. invoke the Stack Advisor on AgentCore Runtime
// 4. compute totals deterministically and store the COMPLETE report

import { BedrockAgentClient, GetKnowledgeBaseDocumentsCommand } from "@aws-sdk/client-bedrock-agent";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { env } from "./shared/http";
import { buildResponse, fileNameFromKey, ReportInput } from "./shared/report-logic";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const kb = new BedrockAgentClient({});
const agentcore = new BedrockAgentCoreClient({
  // Leave headroom under the 15-minute Lambda timeout to record a failure
  requestHandler: { requestTimeout: 12 * 60 * 1000 },
  maxAttempts: 1,
});

const TABLE = env("REPORTS_TABLE");
const BUCKET = env("UPLOADS_BUCKET");
const KNOWLEDGE_BASE_ID = env("KNOWLEDGE_BASE_ID");
const DATA_SOURCE_ID = env("DATA_SOURCE_ID");
const RUNTIME_ARN = env("AGENT_RUNTIME_ARN");

const INGESTION_WAIT_MS = 2 * 60 * 1000;
const INGESTION_POLL_MS = 5000;
const IN_PROGRESS = new Set(["STARTING", "PENDING", "IN_PROGRESS"]);
const USABLE = new Set(["INDEXED", "PARTIALLY_INDEXED"]);

interface Job {
  userId: string;
  reportId: string;
}

export async function handler(job: Job) {
  const { userId, reportId } = job;
  const key = { userId, reportId };

  const item = (await db.send(new GetCommand({ TableName: TABLE, Key: key }))).Item;
  if (!item) return;

  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: key,
        UpdateExpression: "SET #s = :running, updatedAt = :now",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":running": "RUNNING", ":pending": "PENDING", ":now": new Date().toISOString() },
      })
    );
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") return; // already claimed
    throw err;
  }

  try {
    const input: ReportInput = item.input;
    const indexedKeys = await waitForIngestion(item.documentKeys || []);
    // Only tell the advisor about files it can actually search
    input.documentNames = indexedKeys.map(fileNameFromKey);

    const report = await invokeAdvisor(userId, reportId, input);
    const result = buildResponse(report, input);

    await finish(key, { status: "COMPLETE", result });
    console.log("Report complete", { reportId, documents: indexedKeys.length });
  } catch (err) {
    console.error("Report failed", { reportId }, err);
    await finish(key, {
      status: "FAILED",
      error: "We couldn't generate your stack report right now. Please try again in a moment.",
    });
  }
}

async function waitForIngestion(keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  const deadline = Date.now() + INGESTION_WAIT_MS;
  for (;;) {
    const res = await kb.send(
      new GetKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        dataSourceId: DATA_SOURCE_ID,
        documentIdentifiers: keys.map((k) => ({ dataSourceType: "S3", s3: { uri: `s3://${BUCKET}/${k}` } })),
      })
    );
    const statusByUri = new Map((res.documentDetails || []).map((d) => [d.identifier?.s3?.uri, d.status || ""]));
    const statuses = keys.map((k) => statusByUri.get(`s3://${BUCKET}/${k}`) || "");
    // "" / NOT_FOUND = not registered yet: the upload event may still be on its way
    const pending = statuses.some((s) => s === "" || s === "NOT_FOUND" || IN_PROGRESS.has(s));
    if (!pending || Date.now() > deadline) {
      const skipped = keys.map((key, i) => ({ key, status: statuses[i] })).filter((d) => !USABLE.has(d.status));
      if (skipped.length) console.warn("Some context files are not searchable", { skipped });
      return keys.filter((_, i) => USABLE.has(statuses[i]));
    }
    await new Promise((r) => setTimeout(r, INGESTION_POLL_MS));
  }
}

async function invokeAdvisor(userId: string, reportId: string, input: ReportInput) {
  const res = await agentcore.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      qualifier: "DEFAULT",
      runtimeSessionId: reportId, // >= 33 chars, unique per report
      contentType: "application/json",
      accept: "application/json",
      payload: Buffer.from(JSON.stringify({ userId, reportId, input })),
    })
  );
  const body = await res.response!.transformToString();
  if (res.statusCode && res.statusCode >= 400) {
    throw new Error(`Agent runtime returned ${res.statusCode}: ${body.slice(0, 500)}`);
  }
  const parsed = JSON.parse(body);
  if (!parsed?.report?.layers) throw new Error(`Unexpected agent response: ${body.slice(0, 500)}`);
  return parsed.report;
}

async function finish(key: Job, fields: { status: string; result?: unknown; error?: string }) {
  const names: Record<string, string> = { "#s": "status" };
  const values: Record<string, unknown> = { ":s": fields.status, ":now": new Date().toISOString() };
  let update = "SET #s = :s, updatedAt = :now";
  if (fields.result) {
    names["#r"] = "result";
    values[":r"] = fields.result;
    update += ", #r = :r";
  }
  if (fields.error) {
    names["#e"] = "error";
    values[":e"] = fields.error;
    update += ", #e = :e";
  }
  names["#n"] = "reportId";
  values[":deleted"] = "DELETED";
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: key,
        UpdateExpression: update,
        // The user may have deleted the report while it ran; don't bring it back
        ConditionExpression: "attribute_exists(#n) AND #s <> :deleted",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    );
  } catch (err: any) {
    if (err?.name !== "ConditionalCheckFailedException") throw err;
    console.log(JSON.stringify({ msg: "report deleted while running", reportId: key.reportId }));
  }
}
