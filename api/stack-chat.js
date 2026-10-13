const Anthropic = require("@anthropic-ai/sdk");
const { buildIndex, search } = require("../lib/stack-optimizer/retrieval");
const { SYSTEM_PROMPT, parseChatRequest, retrievalQuery, buildMessages } = require("../lib/stack-optimizer/chat");

// Chat with the Context Agent on /stack before the report: answers questions
// about the uploaded files and asks what the report needs. The page sends the
// extracted file text with every message; nothing is stored. Shared logic:
// lib/stack-optimizer/chat.js

const CHAT_MODEL = "claude-haiku-5-5";
const MAX_DOCS = 10;
const MAX_TOTAL_DOC_CHARS = 600000;
const TOP_K = 8;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body || {};
  const chat = parseChatRequest(body);
  if (chat.error) return res.status(400).json({ error: chat.error });

  let budget = MAX_TOTAL_DOC_CHARS;
  const documents = (Array.isArray(body.documents) ? body.documents : [])
    .slice(0, MAX_DOCS)
    .map((d) => {
      const text = typeof (d && d.text) === "string" ? d.text.slice(0, Math.max(0, budget)) : "";
      budget -= text.length;
      return { name: (typeof (d && d.name) === "string" ? d.name : "document").slice(0, 120).replace(/[#<>"]/g, "_"), text };
    })
    .filter((d) => d.text.trim());

  try {
    const index = buildIndex(documents);
    let passages = search(index, retrievalQuery(chat), TOP_K);
    if (chat.kickoff) {
      // Opening message: make sure every file is represented by its first passage
      const firsts = documents.map((d) => index.chunks.find((c) => c.source === d.name)).filter(Boolean);
      const seen = new Set(firsts.map((c) => c.id));
      passages = firsts.concat(passages.filter((p) => !seen.has(p.id))).slice(0, TOP_K + 2);
    }

    const client = new Anthropic({ timeout: 55 * 1000, maxRetries: 1 });
    const response = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1200,
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: buildMessages(chat, passages, documents.length > 0).map((m) => ({ role: m.role, content: m.text })),
    });
    if (response.stop_reason === "refusal") throw new Error("Chat refused");

    const reply = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return res.status(200).json({ reply: reply || "Sorry, I couldn't find an answer. Could you rephrase?" });
  } catch (err) {
    console.error("Stack chat error:", err);
    return res.status(500).json({ error: "The assistant isn't available right now. You can still build your report." });
  }
};
