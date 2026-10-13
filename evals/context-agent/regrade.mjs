#!/usr/bin/env node
// Re-grade saved answers with the current grader, without re-running the agent.
// Reads each row's transcript (the excerpts the agent saw and its answer),
// grades again, and rewrites results.jsonl; the previous file is kept as
// results.grader-v<N>.jsonl. Agent fields (model, usage, latency) are untouched.
//
//   node evals/context-agent/regrade.mjs --flow evals/context-agent/results --variant baseline [--cases id1,id2] [--dry-run]
//
// --dry-run grades and prints, without writing anything.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeAnswer, GRADER_VERSION } from './grader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Anthropic = require(join(resolve(HERE, '..', '..'), 'node_modules', '@anthropic-ai', 'sdk')).default;

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const flow = arg('--flow'), variant = arg('--variant');
const only = arg('--cases')?.split(',');
const dry = process.argv.includes('--dry-run');
if (!flow || !variant) { console.error('usage: regrade.mjs --flow DIR --variant ID [--cases ...] [--dry-run]'); process.exit(2); }

const vdir = join(flow, variant);
const cases = Object.fromEntries(JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8')).map(c => [c.id, c]));
const rows = readFileSync(join(vdir, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const client = new Anthropic();

function runFromTrace(row) {
  const t = JSON.parse(readFileSync(join(vdir, 'traces', `${row.prompt_id}_rep${row.rep}.json`), 'utf8'));
  const user = t.find(x => x.role === 'user').content;
  const passages = [...user.matchAll(/<excerpt id="([^"]+)">\n([\s\S]*?)\n<\/excerpt>/g)].map(m => ({ id: m[1], text: m[2] }));
  return { output: t.findLast(x => x.role === 'assistant').content, passages, refused: row.refused ?? 0 };
}

const prevVersion = rows[0]?.meta?.grader_version ?? 1; // read before grading updates it
const todo = rows.filter(r => !only || only.includes(r.prompt_id));
let next = 0, done = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < todo.length) {
    const row = todo[next++];
    for (let attempt = 0; ; attempt++) {
      try {
        const g = await gradeAnswer(client, cases[row.prompt_id], runFromTrace(row));
        if (dry) console.log(`${row.prompt_id} rep${row.rep}: ${JSON.stringify(row.grade)} -> ${JSON.stringify(g.grade)}\n    ${g.explanation?.no_false_claims?.replace(/\n/g, ' | ')}`);
        Object.assign(row, { grade: g.grade, explanation: g.explanation, judge_model: g.judge_model, judge_usage: g.judge_usage,
          meta: { ...(row.meta ?? {}), grader_version: GRADER_VERSION } });
        break;
      } catch (e) {
        if (attempt >= 4 || !(e?.status === 429 || e?.status >= 500)) throw e;
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt * (0.5 + Math.random())));
      }
    }
    if (++done % 20 === 0) console.error(`${done}/${todo.length} re-graded`);
  }
}));

if (!dry) {
  const backup = join(vdir, `results.grader-v${prevVersion}.jsonl`);
  if (!existsSync(backup)) renameSync(join(vdir, 'results.jsonl'), backup);
  writeFileSync(join(vdir, 'results.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.error(`re-graded ${todo.length} rows -> ${join(vdir, 'results.jsonl')} (previous grades kept in ${backup})`);
}
