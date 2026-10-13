// Keeps the Knowledge Base in step with the uploads bucket, one document at a
// time (direct ingestion, no full data-source sync):
// - Object Created  -> IngestKnowledgeBaseDocuments, with the user_id sidecar as metadata
// - Object Deleted (including 30-day lifecycle expiry) -> DeleteKnowledgeBaseDocuments
// The owner comes from the key (users/<sub>/...), which only uploads.ts issues.

import {
  BedrockAgentClient,
  DeleteKnowledgeBaseDocumentsCommand,
  IngestKnowledgeBaseDocumentsCommand,
} from "@aws-sdk/client-bedrock-agent";
import type { EventBridgeEvent } from "aws-lambda";
import { env } from "./shared/http";

const bedrock = new BedrockAgentClient({});
const KNOWLEDGE_BASE_ID = env("KNOWLEDGE_BASE_ID");
const DATA_SOURCE_ID = env("DATA_SOURCE_ID");

type S3Detail = { bucket: { name: string }; object: { key: string } };

export async function handler(event: EventBridgeEvent<"Object Created" | "Object Deleted", S3Detail>) {
  const bucket = event.detail.bucket.name;
  // EventBridge delivers keys URL-encoded with '+' for spaces
  const key = decodeURIComponent(event.detail.object.key.replace(/\+/g, " "));
  if (key.endsWith(".metadata.json")) return;

  const userId = key.split("/")[1];
  if (!key.startsWith("users/") || !userId) return;

  const s3 = { uri: `s3://${bucket}/${key}` };

  if (event["detail-type"] === "Object Deleted") {
    await bedrock.send(
      new DeleteKnowledgeBaseDocumentsCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        dataSourceId: DATA_SOURCE_ID,
        documentIdentifiers: [{ dataSourceType: "S3", s3 }],
      })
    );
    console.log("Removed document from Knowledge Base", { key });
    return;
  }

  await bedrock.send(
    new IngestKnowledgeBaseDocumentsCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId: DATA_SOURCE_ID,
      documents: [
        {
          content: { dataSourceType: "S3", s3: { s3Location: s3 } },
          // An S3 data source only accepts metadata from S3: the sidecar that
          // uploads.ts writes (with the owner's user_id) before issuing the upload URL
          metadata: { type: "S3_LOCATION", s3Location: { uri: `${s3.uri}.metadata.json` } },
        },
      ],
    })
  );
  console.log("Queued document for ingestion", { key });
}
