const Anthropic = require("@anthropic-ai/sdk");
const { SCHEMA, systemPrompt, parseDocuments, buildUserMessage, clean } = require("../lib/stack-optimizer/autofill");

// Form autofill for /stack — reads the user's uploaded context files and extracts
// what the form asks for (company, industry, region, priorities, stack components
// and costs, key constraints), so the user only reviews and corrects. Nothing is
// stored; the page decides which fields to fill. Shared logic: lib/stack-optimizer/autofill.js

const AUTOFILL_MODEL = "claude-haiku-5-5";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { currency, documents } = parseDocuments(req.body || {});
  if (!documents.length) {
    return res.status(400).json({ error: "Upload at least one file with readable text." });
  }

  try {
    const client = new Anthropic({ timeout: 55 * 1000, maxRetries: 1 });
    const response = await client.messages.create({
      model: AUTOFILL_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: systemPrompt(),
      messages: [{ role: "user", content: buildUserMessage(documents) }],
    });

    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      throw new Error(`Autofill stopped: ${response.stop_reason}`);
    }
    const text = response.content.find((b) => b.type === "text");
    return res.status(200).json(clean(JSON.parse(text ? text.text : ""), currency));
  } catch (err) {
    console.error("Stack autofill error:", err);
    return res.status(500).json({ error: "We couldn't read your files to pre-fill the form. You can fill it in by hand." });
  }
};
