// Lexical retrieval over user-uploaded context files (SOPs, playbooks, tenets, goals).
// Chunks each document and ranks chunks with BM25 so the Context Agent only reads
// the passages relevant to the orchestrator's question.

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;
const BM25_K1 = 1.4;
const BM25_B = 0.75;

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have i if in into is it its of on or our " +
    "so such that the their then there these they this to was we were what when which " +
    "who will with you your can should must may not no all any each per via than also"
  ).split(" ")
);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9äöüéèàçß\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function chunkDocument(doc) {
  const text = doc.text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    // Prefer to break on a paragraph or sentence boundary
    if (end < text.length) {
      const window = text.slice(start, end);
      const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "));
      if (breakAt > CHUNK_SIZE * 0.5) end = start + breakAt + 1;
    }
    chunks.push({
      id: `${doc.name}#${chunks.length + 1}`,
      source: doc.name,
      text: text.slice(start, end).trim(),
    });
    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

function buildIndex(docs) {
  const chunks = docs.flatMap(chunkDocument).filter((c) => c.text.length > 0);
  const docFreq = new Map();
  let totalLength = 0;

  for (const chunk of chunks) {
    chunk.terms = tokenize(chunk.text);
    chunk.termFreq = new Map();
    for (const term of chunk.terms) {
      chunk.termFreq.set(term, (chunk.termFreq.get(term) || 0) + 1);
    }
    for (const term of chunk.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) || 0) + 1);
    }
    totalLength += chunk.terms.length;
  }

  return {
    chunks,
    docFreq,
    avgLength: chunks.length ? totalLength / chunks.length : 0,
  };
}

function search(index, query, topK = 8) {
  const queryTerms = [...new Set(tokenize(query))];
  const N = index.chunks.length;
  if (!N || !queryTerms.length) return [];

  const scored = index.chunks.map((chunk) => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = chunk.termFreq.get(term);
      if (!tf) continue;
      const df = index.docFreq.get(term) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const norm = 1 - BM25_B + BM25_B * (chunk.terms.length / (index.avgLength || 1));
      score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
    }
    return { chunk, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.chunk);
}

module.exports = { buildIndex, search };
