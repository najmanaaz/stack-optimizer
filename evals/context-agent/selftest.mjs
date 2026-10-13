#!/usr/bin/env node
// Grader self-test: pushes known-good and known-bad answers through the real
// grader (no agent call) and checks the grader scores them as expected.
//
//   oracle - the answer key written as an answer, citing a retrieved passage
//            from a file that holds the answer       -> must PASS
//   empty  - ""                                     -> must FAIL
//   idk    - "I don't know."                        -> must FAIL (PASS on questions the documents don't cover)
//   wrong  - a confident answer to another question -> must FAIL
//
//   node evals/context-agent/selftest.mjs [--cases id1,id2]   (needs ANTHROPIC_API_KEY)

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeAnswer } from './grader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);
const Anthropic = require(join(REPO, 'node_modules', '@anthropic-ai', 'sdk')).default;
const { buildIndex, search } = require(join(REPO, 'lib', 'stack-optimizer', 'retrieval.js'));

const DEFAULT_CASES = ['lookup-02', 'lookup-06', 'multi-01', 'multi-03', 'conflict-02', 'conflict-06', 'abstain-01', 'abstain-04', 'injection-02'];
const arg = process.argv.indexOf('--cases');
const ids = arg > 0 ? process.argv[arg + 1].split(',') : DEFAULT_CASES;

const FIXTURES = join(HERE, 'fixtures', 'nordlicht');
const index = buildIndex(readdirSync(FIXTURES).sort()
  .map(name => ({ name, text: readFileSync(join(FIXTURES, name), 'utf8') })));
const cases = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8')).filter(c => ids.includes(c.id));
const client = new Anthropic();

const WRONG = 'Yes. Google Cloud Platform is approved for customer data, logs are kept for at most 90 days, '
  + 'and Datadog renews on 1 March 2026 with 30 days\' notice. [nordlicht-security-policy-v1-2024.txt#1]';

function oracle(c, passages) {
  if (c.should_abstain) return 'No relevant context found.';
  // Show the judge every passage of the answer files, so each key fact is supported
  for (const ch of index.chunks.filter(ch => c.expected_sources.includes(ch.source)))
    if (!passages.some(p => p.id === ch.id)) passages.push({ id: ch.id, text: ch.text });
  const hit = passages.find(p => c.expected_sources.includes(p.id.split('#')[0]));
  return c.required_facts.map(f => `- ${f} [${hit.id}]`).join('\n');
}

const kinds = { oracle: 1, empty: 0, idk: 0, wrong: 0 };
const tally = Object.fromEntries(Object.keys(kinds).map(k => [k, { pass: 0, n: 0, misses: [] }]));
const jobs = [];
for (const c of cases) for (const kind of Object.keys(kinds)) {
  jobs.push(async () => {
    const passages = search(index, c.question, 8).map(p => ({ id: p.id, text: p.text }));
    const output = kind === 'oracle' ? oracle(c, passages)
      : kind === 'empty' ? '' : kind === 'idk' ? "I don't know." : WRONG;
    const g = await gradeAnswer(client, c, { output, passages, refused: 0 });
    const t = tally[kind];
    // "I don't know." is a fair way to decline a question the documents don't cover
    const expected = kind === 'idk' && c.should_abstain ? 1 : kinds[kind];
    t.n++; t.pass += g.grade.pass === expected ? 1 : 0;
    if (g.grade.pass !== expected) t.misses.push(`${c.id} ${JSON.stringify(g.grade)} ${g.explanation?.pass ?? ''}`);
  });
}
// 4 at a time
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => { while (next < jobs.length) await jobs[next++](); }));

let ok = true;
for (const [kind, t] of Object.entries(tally)) {
  const good = t.pass === t.n;
  ok &&= good;
  console.log(`${good ? 'OK  ' : 'BAD '} ${kind.padEnd(6)} ${t.pass}/${t.n} graded as expected`);
  for (const m of t.misses) console.log(`       ${m}`);
}
process.exit(ok ? 0 : 1);
