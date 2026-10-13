// POST /chat — the Context Agent on the page: answers questions about the
// signed-in user's uploaded files and asks what the report needs. Same prompt
// and validation as the Vercel version (lib/stack-optimizer/chat.js), here with
// the Bedrock Knowledge Base (filtered to the caller) and Claude on Bedrock.
// Nothing is stored; the page sends the conversation with the report.

import { BedrockAgentClient, GetKnowledgeBaseDocumentsCommand } from "@aws-sdk/client-bedrock-agent";
import { BedrockAgentRuntimeClient, RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { ApiEvent, env, json, parseBody, userIdOf } from "./shared/http";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SYSTEM_PROMPT, parseChatRequest, retrievalQuery, buildMessages } = require("../../lib/stack-optimizer/chat");

const kb = new BedrockAgentClient({});
const kbRuntime = new BedrockAgentRuntimeClient({});
const bedrock = new BedrockRuntimeClient({ maxAttempts: 2 });
const MODEL_ID = env("CHAT_MODEL_ID");
const KNOWLEDGE_BASE_ID = env("KNOWLEDGE_BASE_ID");
const DATA_SOURCE_ID = env("DATA_SOURCE_ID");
const BUCKET = env("UPLOADS_BUCKET");
const TOP_K = 8;
const MAX_DOCUMENTS = 10;
const IN_PROGRESS = new Set(["STARTING", "PENDING", "IN_PROGRESS"]);

export async function handler(event: ApiEvent) {
  const userId = userIdOf(event);
  const body = parseBody(event);
  if (!body) return json(400, { error: "Invalid request body." });

  const chat = parseChatRequest(body);
  if (chat.error) return json(400, { error: chat.error });

  // Only the caller's own uploads, in the shape the uploads handler issues
  const prefix = `users/${userId}/`;
  const keys: string[] = (Array.isArray(body.documentKeys) ? body.documentKeys : [])
    .filter((k: unknown): k is string => typeof k === "string" && k.startsWith(prefix) && !k.includes(".."))
    .slice(0, MAX_DOCUMENTS);

  try {
    if (keys.length && (await stillIndexing(keys))) {
      return json(200, { status: "indexing" });
    }
    const passages = keys.length ? await retrieve(userId, retrievalQuery(chat)) : [];
    const messages = buildMessages(chat, passages, keys.length > 0).map((m: { role: "user" | "assistant"; text: string }) => ({
      role: m.role,
      content: [{ text: m.text }],
    }));

    const started = Date.now();
    const res = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: SYSTEM_PROMPT }],
        messages,
        inferenceConfig: { maxTokens: 1200 },
      })
    );
    const reply = (res.output?.message?.content || []).map((b) => b.text || "").join("\n").trim();
    // One line per turn for observability and later evaluation (no message text)
    console.log(
      JSON.stringify({
        msg: "chat turn",
        kickoff: chat.kickoff,
        turns: chat.messages.length,
        passages: passages.map((p) => p.id),
        ms: Date.now() - started,
        inputTokens: res.usage?.inputTokens,
        outputTokens: res.usage?.outputTokens,
      })
    );
    return json(200, { status: "ok", reply: reply || "Sorry, I couldn't find an answer. Could you rephrase?" });
  } catch (err) {
    console.error("Chat failed", err);
    return json(500, { error: "The assistant isn't available right now. You can still build your report." });
  }
}

// Files become searchable a minute or two after upload
async function stillIndexing(keys: string[]): Promise<boolean> {
  const res = await kb.send(
    new GetKnowledgeBaseDocumentsCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      dataSourceId: DATA_SOURCE_ID,
      documentIdentifiers: keys.map((k) => ({ dataSourceType: "S3", s3: { uri: `s3://${BUCKET}/${k}` } })),
    })
  );
  const statusByUri = new Map((res.documentDetails || []).map((d) => [d.identifier?.s3?.uri, d.status || ""]));
  // "" / NOT_FOUND = not registered yet: the upload event may still be on its way
  return keys.some((k) => {
    const s = statusByUri.get(`s3://${BUCKET}/${k}`) || "";
    return s === "" || s === "NOT_FOUND" || IN_PROGRESS.has(s);
  });
}

async function retrieve(userId: string, query: string) {
  const res = await kbRuntime.send(
    new RetrieveCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: TOP_K,
          // The user id comes from the verified token, never from the request body
          filter: { equals: { key: "user_id", value: userId } },
        },
      },
    })
  );
  const perFile = new Map<string, number>();
  const passages: { id: string; text: string }[] = [];
  for (const r of res.retrievalResults || []) {
    const text = (r.content?.text || "").trim();
    if (!text) continue;
    const uri = r.location?.s3Location?.uri || "";
    const name = decodeURIComponent(uri.split("/").pop() || "") || "document";
    perFile.set(name, (perFile.get(name) || 0) + 1);
    passages.push({ id: `${name}#${perFile.get(name)}`, text });
  }
  return passages;
}
