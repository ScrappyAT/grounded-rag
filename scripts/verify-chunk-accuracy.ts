import { query, dbPool } from '../src/lib/db/client';
import * as fs from 'fs';
import * as path from 'path';

async function verifyChunkAccuracy() {
  const gt = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../evaluation/ground-truth.json'), 'utf8'));
  const v2 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../evaluation/2x2-evaluation-results-v2.json'), 'utf8'));
  const cases = v2.cases.filter((c: any) => c.strategy === 'structure_aware' && c.topK === 5 && c.isAnswerable);

  console.log(`Auditing ${cases.length} answerable cases in Structure-Aware (k=5)...`);
  let chunkHits = 0;

  for (const c of cases) {
    const q = gt.find((x: any) => x.id === c.questionId);
    const targetSecs = (q.target_sections || []).map((s: string) => s.toLowerCase());

    const rows = await query(
      'SELECT section_title, content FROM chunks WHERE id = ANY($1::uuid[])',
      [c.retrievedChunkIds]
    );

    const secTitles = rows.map((r: any) => (r.section_title || '').toLowerCase());
    const matched = targetSecs.some((ts: string) =>
      secTitles.some((st: string) => st.includes(ts) || ts.includes(st))
    );

    if (matched) {
      chunkHits++;
    } else {
      console.log(`\nPotential Section Mismatch on ${c.questionId}:`);
      console.log(`  Target Sections:   ${JSON.stringify(targetSecs)}`);
      console.log(`  Retrieved Sections:${JSON.stringify(secTitles)}`);
    }
  }

  console.log(`\nChunk-Level Target Section Accuracy: ${chunkHits}/${cases.length} (${((chunkHits / cases.length) * 100).toFixed(1)}%)`);
  await dbPool.end();
  process.exit(0);
}

verifyChunkAccuracy().catch(err => {
  console.error(err);
  process.exit(1);
});

