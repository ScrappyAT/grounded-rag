import * as fs from 'fs';
import * as path from 'path';
import { query, dbPool } from '../src/lib/db/client';

function escapeSqlString(str: string | null | undefined): string {
  if (str === null || str === undefined) return 'NULL';
  return "'" + str.replace(/'/g, "''") + "'";
}

function escapeSqlDate(date: any): string {
  if (!date) return 'NULL';
  if (date instanceof Date) {
    return `'${date.toISOString().split('T')[0]}'`;
  }
  return `'${String(date).split('T')[0]}'`;
}

function escapeSqlJson(obj: any): string {
  if (!obj) return "'{}'::jsonb";
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return "'" + str.replace(/'/g, "''") + "'::jsonb";
}

async function exportSeedData() {
  console.log('======================================================');
  console.log('       Grounded RAG — Export Production Seed Data     ');
  console.log('======================================================\n');

  try {
    // 1. Export Documents
    console.log('Querying documents from database...');
    const documents = await query(`
      SELECT
        id, title, category, department, version, status,
        effective_date, supersedes, file_path, file_type,
        content_hash, ingestion_status, created_at, updated_at
      FROM documents
      ORDER BY id ASC
    `);

    console.log(`Found ${documents.length} documents.`);

    // 2. Export Chunks (MiniLM 384-dim only)
    console.log('Querying legitimate MiniLM 384-dim chunks...');
    const chunks = await query(`
      SELECT
        id, document_id, strategy, chunk_index, content,
        section_title, page_number, token_count, content_hash,
        model_id, dimensions, corpus_version, metadata,
        embedding_384::text AS embedding_384_text
      FROM chunks
      WHERE model_id = 'Xenova/all-MiniLM-L6-v2' AND dimensions = 384
      ORDER BY document_id ASC, strategy ASC, chunk_index ASC
    `);

    console.log(`Found ${chunks.length} chunks for Xenova/all-MiniLM-L6-v2 (384-dim).`);

    // 3. Export Embedding Cache (MiniLM 384-dim only)
    console.log('Querying embedding cache...');
    const cacheEntries = await query(`
      SELECT
        content_hash, model_id, dimensions,
        embedding_384::text AS embedding_384_text
      FROM embedding_cache
      WHERE model_id = 'Xenova/all-MiniLM-L6-v2' AND dimensions = 384
      ORDER BY content_hash ASC
    `);

    console.log(`Found ${cacheEntries.length} embedding cache records.`);

    // 4. Build SQL Script
    const sqlStatements: string[] = [];
    sqlStatements.push('-- Grounded RAG Production Seed Script');
    sqlStatements.push('-- Generated: ' + new Date().toISOString());
    sqlStatements.push('-- Model: Xenova/all-MiniLM-L6-v2 (384 dimensions)');
    sqlStatements.push('-- Documents: ' + documents.length);
    sqlStatements.push('-- Chunks: ' + chunks.length);
    sqlStatements.push('');
    sqlStatements.push('BEGIN;');
    sqlStatements.push('');
    sqlStatements.push('-- 1. Insert Documents');
    for (const doc of documents) {
      sqlStatements.push(`INSERT INTO documents (
  id, title, category, department, version, status, effective_date, supersedes, file_path, file_type, content_hash, ingestion_status
) VALUES (
  ${escapeSqlString(doc.id)},
  ${escapeSqlString(doc.title)},
  ${escapeSqlString(doc.category)},
  ${escapeSqlString(doc.department)},
  ${escapeSqlString(doc.version)},
  ${escapeSqlString(doc.status)},
  ${escapeSqlDate(doc.effective_date)},
  ${escapeSqlString(doc.supersedes)},
  ${escapeSqlString(doc.file_path)},
  ${escapeSqlString(doc.file_type)},
  ${escapeSqlString(doc.content_hash)},
  ${escapeSqlString(doc.ingestion_status)}
) ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  category = EXCLUDED.category,
  department = EXCLUDED.department,
  version = EXCLUDED.version,
  status = EXCLUDED.status,
  effective_date = EXCLUDED.effective_date,
  supersedes = EXCLUDED.supersedes,
  content_hash = EXCLUDED.content_hash,
  ingestion_status = EXCLUDED.ingestion_status,
  updated_at = NOW();`);
    }

    sqlStatements.push('');
    sqlStatements.push('-- 2. Insert Chunks (Xenova/all-MiniLM-L6-v2 384-dim)');
    for (const c of chunks) {
      const vecLiteral = c.embedding_384_text ? `'${c.embedding_384_text}'::vector` : 'NULL';
      sqlStatements.push(`INSERT INTO chunks (
  id, document_id, strategy, chunk_index, content, section_title, page_number,
  token_count, content_hash, model_id, dimensions, corpus_version, metadata, embedding_384
) VALUES (
  ${escapeSqlString(c.id)},
  ${escapeSqlString(c.document_id)},
  ${escapeSqlString(c.strategy)},
  ${c.chunk_index},
  ${escapeSqlString(c.content)},
  ${escapeSqlString(c.section_title)},
  ${c.page_number !== null ? c.page_number : 'NULL'},
  ${c.token_count},
  ${escapeSqlString(c.content_hash)},
  ${escapeSqlString(c.model_id)},
  ${c.dimensions},
  ${escapeSqlString(c.corpus_version)},
  ${escapeSqlJson(c.metadata)},
  ${vecLiteral}
) ON CONFLICT (id) DO NOTHING;`);
    }

    sqlStatements.push('');
    sqlStatements.push('-- 3. Insert Embedding Cache');
    for (const e of cacheEntries) {
      const vecLiteral = e.embedding_384_text ? `'${e.embedding_384_text}'::vector` : 'NULL';
      sqlStatements.push(`INSERT INTO embedding_cache (
  content_hash, model_id, dimensions, embedding_384
) VALUES (
  ${escapeSqlString(e.content_hash)},
  ${escapeSqlString(e.model_id)},
  ${e.dimensions},
  ${vecLiteral}
) ON CONFLICT (content_hash, model_id, dimensions) DO NOTHING;`);
    }

    sqlStatements.push('');
    sqlStatements.push('COMMIT;');

    const outDir = path.resolve(__dirname, '..', 'src', 'lib', 'db');
    const sqlPath = path.join(outDir, 'seed-data.sql');
    fs.writeFileSync(sqlPath, sqlStatements.join('\n'), 'utf8');

    // Also write a structured validation manifest
    const manifestPath = path.join(outDir, 'seed-manifest.json');
    const manifest = {
      exportedAt: new Date().toISOString(),
      modelId: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
      documentCount: documents.length,
      chunkCount: chunks.length,
      cacheCount: cacheEntries.length,
      chunksByStrategy: {
        fixed: chunks.filter(c => c.strategy === 'fixed').length,
        structure_aware: chunks.filter(c => c.strategy === 'structure_aware').length,
      },
      documentsByCategory: documents.reduce((acc: any, d) => {
        acc[d.category] = (acc[d.category] || 0) + 1;
        return acc;
      }, {}),
      documentsByDepartment: documents.reduce((acc: any, d) => {
        acc[d.department] = (acc[d.department] || 0) + 1;
        return acc;
      }, {}),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    console.log(`\nSeed SQL written to: ${sqlPath} (${(fs.statSync(sqlPath).size / (1024 * 1024)).toFixed(2)} MB)`);
    console.log(`Seed Manifest written to: ${manifestPath}`);
    console.log('Export completed successfully!');
  } finally {
    await dbPool.end();
  }
}

exportSeedData().catch(err => {
  console.error('Export error:', err);
  process.exit(1);
});
