import * as fs from 'fs';
import * as path from 'path';
import { query, dbPool } from '../src/lib/db/client';

async function validateSeedData() {
  console.log('======================================================');
  console.log('       Grounded RAG — Validate Production Seed Data   ');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✓ ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ FAILED: ${msg}`);
      failed++;
    }
  }

  const manifestPath = path.resolve(__dirname, '../src/lib/db/seed-manifest.json');
  const sqlPath = path.resolve(__dirname, '../src/lib/db/seed-data.sql');

  assert(fs.existsSync(manifestPath), 'seed-manifest.json exists');
  assert(fs.existsSync(sqlPath), 'seed-data.sql exists');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // 1. Verify Manifest Counts
  assert(manifest.documentCount === 220, `Document count is exactly 220 (got ${manifest.documentCount})`);
  assert(manifest.chunkCount === 1517, `Chunk count is exactly 1,517 (got ${manifest.chunkCount})`);
  assert(manifest.modelId === 'Xenova/all-MiniLM-L6-v2', `Model ID is Xenova/all-MiniLM-L6-v2 (got ${manifest.modelId})`);
  assert(manifest.dimensions === 384, `Dimensions is 384 (got ${manifest.dimensions})`);

  // 2. Validate SQL file structure
  const sqlContent = fs.readFileSync(sqlPath, 'utf8');
  assert(sqlContent.includes('BEGIN;'), 'SQL script begins transaction');
  assert(sqlContent.includes('COMMIT;'), 'SQL script commits transaction');
  assert(sqlContent.includes("model_id, dimensions"), 'SQL script sets model_id and dimensions');
  assert(!sqlContent.includes('gemini-embedding-001'), 'SQL script contains NO gemini-embedding-001 vectors');
  assert(!sqlContent.includes('mock-embedding'), 'SQL script contains NO mock-embedding vectors');

  // Count occurrences of INSERT INTO documents and chunks
  const docInserts = (sqlContent.match(/INSERT INTO documents/g) || []).length;
  const chunkInserts = (sqlContent.match(/INSERT INTO chunks/g) || []).length;
  assert(docInserts === 220, `SQL has 220 document INSERT statements (got ${docInserts})`);
  assert(chunkInserts === 1517, `SQL has 1,517 chunk INSERT statements (got ${chunkInserts})`);

  // 3. Inspect sample vector dimensions in SQL file
  const vectorMatches = sqlContent.match(/'\[([-0-9.,eE+ ]+)\]'::vector/g) || [];
  assert(vectorMatches.length > 0, `SQL script contains vector literals (found ${vectorMatches.length})`);

  if (vectorMatches.length > 0 && vectorMatches[0]) {
    const sampleVecStr = vectorMatches[0].replace(/'/g, '').replace('::vector', '');
    const sampleVec = JSON.parse(sampleVecStr);
    assert(sampleVec.length === 384, `Sample vector literal has exactly 384 dimensions (got ${sampleVec.length})`);
  }

  // 4. Verify Database HNSW Indexes and Integrity (if DB is reachable)
  try {
    const indexes = await query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'chunks' AND indexname = 'idx_chunks_hnsw_384'
    `);
    assert(indexes.length === 1, 'HNSW vector index idx_chunks_hnsw_384 exists in PostgreSQL schema');
    if (indexes.length > 0) {
      assert(indexes[0].indexdef.includes('vector_cosine_ops'), 'idx_chunks_hnsw_384 uses vector_cosine_ops');
    }

    const chunkStats = await query(`
      SELECT
        COUNT(*)::int AS count,
        COUNT(DISTINCT document_id)::int AS distinct_docs,
        MIN(dimensions)::int AS min_dim,
        MAX(dimensions)::int AS max_dim,
        COUNT(embedding_384)::int AS vec_count
      FROM chunks
      WHERE model_id = 'Xenova/all-MiniLM-L6-v2' AND dimensions = 384
    `);

    const cs = chunkStats[0];
    assert(cs.count === 1517, `Database has 1,517 chunks for Xenova/all-MiniLM-L6-v2 (got ${cs.count})`);
    assert(cs.distinct_docs === 220, `All 220 documents are represented in chunks (got ${cs.distinct_docs})`);
    assert(cs.min_dim === 384 && cs.max_dim === 384, 'All chunks have dimension 384');
    assert(cs.vec_count === 1517, `All 1,517 chunks have non-null embedding_384 (got ${cs.vec_count})`);

  } catch (err: any) {
    console.log(`ℹ Database live connection skipped (${err.message}). Seed SQL & manifest validated independently.`);
  } finally {
    try {
      await dbPool.end();
    } catch {}
  }

  console.log('\n======================================================');
  console.log(`Validation Summary: Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log('======================================================');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

validateSeedData().catch(err => {
  console.error('Validation error:', err);
  process.exit(1);
});
