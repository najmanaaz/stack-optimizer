// Report jobs for the signed-in user:
//   POST /reports            validate input, store PENDING job, start the worker
//   GET  /reports            list the user's reports (newest first)
//   GET  /reports/{reportId} poll one report; result included once COMPLETE
//   DELETE /reports/{reportId} delete a report and the files uploaded for it

import { randomUUID } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { ApiEvent, env, json, parseBody, userIdOf } from "./shared/http";
import { parseReportInput } from "./shared/report-logic";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const lambda = new LambdaClient({});
const s3 = new S3Client({});
const TABLE = env("REPORTS_TABLE");
const BUCKET = env("UPLOADS_BUCKET");
const WORKER = env("WORKER_FUNCTION");
const RETENTION_DAYS = Number(env("REPORT_RETENTION_DAYS"));
const PER_DAY = Number(env("REPORTS_PER_USER_PER_DAY"));
const MAX_DOCUMENTS = Number(env("DOCUMENTS_PER_REPORT"));
// A worker that runs longer than its Lambda timeout was killed; report it as failed.
const STALE_AFTER_MS = 16 * 60 * 1000;
// A deleted report leaves a content-free marker so it still counts toward the daily limit
const DELETED_MARKER_DAYS = 2;

// Report ids sort by creation time: <yyyymmddhhmmss>-<uuid>
const REPORT_ID = /^\d{14}-[0-9a-f-]{36}$/;

export async function handler(event: ApiEvent) {
  const userId = userIdOf(event);
  switch (event.routeKey) {
    case "POST /reports":
      return createReport(event, userId);
    case "GET /reports":
      return listReports(userId);
    case "GET /reports/{reportId}":
      return getReport(userId, event.pathParameters?.reportId || "");
    case "DELETE /reports/{reportId}":
      return deleteReport(userId, event.pathParameters?.reportId || "");
    default:
      return json(404, { error: "Not found" });
  }
}

async function createReport(event: ApiEvent, userId: string) {
  const body = parseBody(event);
  if (!body) return json(400, { error: "Invalid request body." });

  const parsed = parseReportInput(body, userId, MAX_DOCUMENTS);
  if ("error" in parsed) return json(400, { error: parsed.error });

  const now = new Date();
  const recent = await db.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "userId = :u AND reportId >= :since",
      ExpressionAttributeValues: { ":u": userId, ":since": idPrefix(new Date(now.getTime() - 24 * 3600 * 1000)) },
      Select: "COUNT",
    })
  );
  if ((recent.Count || 0) >= PER_DAY) {
    return json(429, { error: `You can run up to ${PER_DAY} reports per day. Please try again tomorrow.` });
  }

  const reportId = `${idPrefix(now)}-${randomUUID()}`;
  await db.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        userId,
        reportId,
        status: "PENDING",
        company: parsed.input.company,
        input: parsed.input,
        documentKeys: parsed.documentKeys,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: Math.floor(now.getTime() / 1000) + RETENTION_DAYS * 24 * 3600,
      },
    })
  );

  await lambda.send(
    new InvokeCommand({
      FunctionName: WORKER,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ userId, reportId })),
    })
  );

  return json(202, { reportId, status: "PENDING" });
}

async function listReports(userId: string) {
  const res = await db.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId, ":deleted": "DELETED" },
      FilterExpression: "#s <> :deleted",
      // Summary only: status and headline totals, not the full report
      ExpressionAttributeNames: { "#s": "status", "#r": "result", "#e": "error" },
      ProjectionExpression: "reportId, #s, company, createdAt, updatedAt, #e, #r.totals, #r.currency",
      ScanIndexForward: false,
      Limit: 50,
    })
  );
  return json(200, { reports: (res.Items || []).map(present) });
}

async function getReport(userId: string, reportId: string) {
  if (!REPORT_ID.test(reportId)) return json(404, { error: "Report not found." });
  const res = await db.send(new GetCommand({ TableName: TABLE, Key: { userId, reportId } }));
  if (!res.Item || res.Item.status === "DELETED") return json(404, { error: "Report not found." });
  return json(200, present(res.Item));
}

async function deleteReport(userId: string, reportId: string) {
  if (!REPORT_ID.test(reportId)) return json(404, { error: "Report not found." });
  const res = await db.send(new GetCommand({ TableName: TABLE, Key: { userId, reportId } }));
  if (!res.Item || res.Item.status === "DELETED") return json(404, { error: "Report not found." });

  // Files can be attached to more than one report; keep those another report still uses
  const others = await db.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
      ProjectionExpression: "reportId, documentKeys",
    })
  );
  const inUse = new Set<string>();
  for (const item of others.Items || []) {
    if (item.reportId !== reportId) for (const k of item.documentKeys || []) inUse.add(k);
  }
  const prefix = `users/${userId}/`;
  const keys = ((res.Item.documentKeys || []) as string[]).filter((k) => k.startsWith(prefix) && !inUse.has(k));
  if (keys.length) {
    // Deleting the file also removes it from the knowledge base (see ingest.ts)
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: keys.flatMap((k) => [{ Key: k }, { Key: `${k}.metadata.json` }]), Quiet: true },
      })
    );
  }

  const now = new Date();
  await db.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        userId,
        reportId,
        status: "DELETED",
        createdAt: res.Item.createdAt,
        updatedAt: now.toISOString(),
        expiresAt: Math.floor(now.getTime() / 1000) + DELETED_MARKER_DAYS * 24 * 3600,
      },
    })
  );
  return json(200, { reportId, deleted: true, filesDeleted: keys.length });
}

function present(item: Record<string, any>) {
  const stale =
    (item.status === "PENDING" || item.status === "RUNNING") &&
    Date.now() - Date.parse(item.updatedAt) > STALE_AFTER_MS;
  return {
    reportId: item.reportId,
    status: stale ? "FAILED" : item.status,
    company: item.company || "",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(stale ? { error: "The report took too long to generate. Please try again." } : {}),
    ...(item.error && !stale ? { error: item.error } : {}),
    ...(item.result ? { result: item.result } : {}),
  };
}

function idPrefix(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}
