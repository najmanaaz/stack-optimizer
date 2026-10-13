// POST /autofill — reads the text of the user's context files (extracted in the
// browser) and returns what the form asks for, so the user only reviews and
// corrects. Same instructions and validation as the Vercel version
// (lib/stack-optimizer/autofill.js), here with Claude on Bedrock. Nothing is stored.

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { ApiEvent, env, json, parseBody } from "./shared/http";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SCHEMA, systemPrompt, parseDocuments, buildUserMessage, clean } = require("../../lib/stack-optimizer/autofill");

const bedrock = new BedrockRuntimeClient({ maxAttempts: 2 });
const MODEL_ID = env("AUTOFILL_MODEL_ID");
const TOOL_NAME = "fill_form";

export async function handler(event: ApiEvent) {
  const body = parseBody(event);
  if (!body) return json(400, { error: "Invalid request body." });

  const { currency, documents } = parseDocuments(body);
  if (!documents.length) return json(400, { error: "Upload at least one file with readable text." });

  try {
    const res = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        system: [{ text: systemPrompt() }],
        messages: [{ role: "user", content: [{ text: buildUserMessage(documents) }] }],
        inferenceConfig: { maxTokens: 4000 },
        toolConfig: {
          tools: [{ toolSpec: { name: TOOL_NAME, description: "Submit the filled-in form.", inputSchema: { json: SCHEMA } } }],
          toolChoice: { tool: { name: TOOL_NAME } },
        },
      })
    );
    const call = res.output?.message?.content?.find((b) => b.toolUse?.name === TOOL_NAME);
    if (!call?.toolUse?.input) throw new Error(`No form in response (stopReason=${res.stopReason})`);
    return json(200, clean(call.toolUse.input, currency));
  } catch (err) {
    console.error("Autofill failed", err);
    return json(500, { error: "We couldn't read your files to pre-fill the form. You can fill it in by hand." });
  }
}
