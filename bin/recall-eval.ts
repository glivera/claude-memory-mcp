import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateEmbedding } from '../src/embedding.js';
import { matchMemories, matchMemoriesHybrid } from '../src/db.js';

interface QueryCase {
  id: string;
  lang: string;
  source: string;
  query: string;
  expected: string[];
}

interface QueriesFile {
  description: string;
  queries: QueryCase[];
}

interface QueryScore {
  id: string;
  lang: string;
  source: string;
  cosineRecall: number;
  hybridRecall: number;
  lostIds: string[];
}

const MATCH_COUNT = 10;
const THRESHOLD = 0.25;

function recallAt10(returnedIds: string[], expected: string[]): number {
  if (expected.length === 0) return 0;
  const returnedSet = new Set(returnedIds);
  const hits = expected.filter((id) => returnedSet.has(id)).length;
  return hits / expected.length;
}

function loadQueries(): QueryCase[] {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  // queries.local.json is gitignored: real eval sets reference private
  // memory content and must never reach the public repo. The committed
  // queries.example.json only documents the format.
  const localPath = path.join(scriptDir, '../tests/eval/queries.local.json');
  const examplePath = path.join(scriptDir, '../tests/eval/queries.example.json');
  const queriesPath = existsSync(localPath) ? localPath : examplePath;
  if (queriesPath === examplePath) {
    console.error('[recall-eval] tests/eval/queries.local.json not found -- running on the example set (format demo only)');
  }
  const raw = readFileSync(queriesPath, 'utf-8');
  const parsed = JSON.parse(raw) as QueriesFile;
  return parsed.queries;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function printAggregateRow(label: string, scores: QueryScore[]): void {
  if (scores.length === 0) return;
  const cosineAvg = average(scores.map((s) => s.cosineRecall));
  const hybridAvg = average(scores.map((s) => s.hybridRecall));
  const delta = hybridAvg - cosineAvg;
  const marker = delta < 0 ? '<<' : '';
  console.log(
    `${label.padEnd(16)}${''.padEnd(4)}${''.padEnd(12)}${cosineAvg.toFixed(2).padEnd(10)}${hybridAvg.toFixed(2).padEnd(10)}${delta.toFixed(2).padEnd(8)}${marker}`
  );
}

async function main(): Promise<void> {
  const queries = loadQueries();
  const scores: QueryScore[] = [];

  console.log(
    `${'id'.padEnd(16)}${'lang'.padEnd(4)}${'source'.padEnd(12)}${'cosineR@10'.padEnd(10)}${'hybridR@10'.padEnd(10)}${'delta'.padEnd(8)}marker`
  );
  console.log('-'.repeat(70));

  for (const q of queries) {
    let cosineIds: string[] = [];
    let hybridIds: string[] = [];
    let cosineRecall = 0;
    let hybridRecall = 0;

    try {
      const embedding = await generateEmbedding(q.query);

      try {
        const cosineResults = await matchMemories(embedding, null, null, MATCH_COUNT, THRESHOLD, null);
        cosineIds = cosineResults.map((r) => r.id);
        cosineRecall = recallAt10(cosineIds, q.expected);
      } catch (err) {
        console.log(`[${q.id}] cosine RPC error: ${err instanceof Error ? err.message : String(err)}`);
        cosineRecall = 0;
      }

      try {
        const hybridResults = await matchMemoriesHybrid(embedding, q.query, null, null, MATCH_COUNT, THRESHOLD, null);
        hybridIds = hybridResults.map((r) => r.id);
        hybridRecall = recallAt10(hybridIds, q.expected);
      } catch (err) {
        console.log(`[${q.id}] hybrid RPC error: ${err instanceof Error ? err.message : String(err)}`);
        hybridRecall = 0;
      }
    } catch (err) {
      console.log(`[${q.id}] embedding error: ${err instanceof Error ? err.message : String(err)}`);
      cosineRecall = 0;
      hybridRecall = 0;
    }

    const cosineFoundExpected = new Set(q.expected.filter((id) => cosineIds.includes(id)));
    const hybridFoundExpected = new Set(q.expected.filter((id) => hybridIds.includes(id)));
    const lostIds = [...cosineFoundExpected].filter((id) => !hybridFoundExpected.has(id));

    const delta = hybridRecall - cosineRecall;
    const marker = delta < 0 ? '<<' : '';

    console.log(
      `${q.id.padEnd(16)}${q.lang.padEnd(4)}${q.source.padEnd(12)}${cosineRecall.toFixed(2).padEnd(10)}${hybridRecall.toFixed(2).padEnd(10)}${delta.toFixed(2).padEnd(8)}${marker}`
    );

    scores.push({ id: q.id, lang: q.lang, source: q.source, cosineRecall, hybridRecall, lostIds });
  }

  console.log('-'.repeat(70));
  printAggregateRow('ALL', scores);
  printAggregateRow('lang=en', scores.filter((s) => s.lang === 'en'));
  printAggregateRow('lang=ru', scores.filter((s) => s.lang === 'ru'));
  printAggregateRow('source=mined', scores.filter((s) => s.source === 'mined'));
  printAggregateRow('source=paraphrase', scores.filter((s) => s.source === 'paraphrase'));

  const regressions = scores.filter((s) => s.hybridRecall < s.cosineRecall);
  if (regressions.length > 0) {
    console.log('');
    console.log('Hybrid regressions (expected ids lost vs cosine):');
    for (const r of regressions) {
      console.log(`  [${r.id}] lost: ${r.lostIds.length > 0 ? r.lostIds.join(', ') : '(none, but recall still dropped)'}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  })
  .finally(() => {
    process.exit(0);
  });
