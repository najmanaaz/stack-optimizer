// POST /uploads — issues a presigned S3 PUT for one context file under the
// caller's prefix (users/<sub>/<uuid>/<name>) and writes the metadata sidecar
// that tags its Knowledge Base chunks with user_id. Ingestion starts when the
// upload lands (see ingest.ts).

import { randomUUID } from "crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ApiEvent, env, json, parseBody, userIdOf } from "./shared/http";

const s3 = new S3Client({});
const BUCKET = env("UPLOADS_BUCKET");
const MAX_BYTES = Number(env("MAX_UPLOAD_BYTES"));
const URL_TTL_SECONDS = 300;

// File types the Knowledge Base can parse
const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export async function handler(event: ApiEvent) {
  const userId = userIdOf(event);
  const body = parseBody(event);
  if (!body) return json(400, { error: "Invalid request body." });

  const fileName = sanitizeFileName(body.fileName);
  const ext = fileName.split(".").pop()!.toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  const size = Number(body.size);
  if (!fileName || !contentType) {
    return json(400, { error: `Supported file types: ${Object.keys(CONTENT_TYPES).join(", ")}.` });
  }
  if (!Number.isInteger(size) || size <= 0 || size > MAX_BYTES) {
    return json(400, { error: `Files must be under ${Math.floor(MAX_BYTES / (1024 * 1024))} MB.` });
  }

  const key = `users/${userId}/${randomUUID()}/${fileName}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${key}.metadata.json`,
      ContentType: "application/json",
      Body: JSON.stringify({ metadataAttributes: { user_id: userId } }),
    })
  );

  // Content type and length are signed, so the browser must upload exactly this file.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn: URL_TTL_SECONDS }
  );

  return json(200, { key, uploadUrl, contentType, expiresIn: URL_TTL_SECONDS });
}

function sanitizeFileName(value: unknown): string {
  if (typeof value !== "string") return "";
  const base = value.split(/[\\/]/).pop() || "";
  return base
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(-120);
}
