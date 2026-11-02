import * as fs from 'fs';
import * as path from 'path';
import { loadDocument } from '../src/lib/rag/loader';
import { chunkFixedSize } from '../src/lib/rag/chunkers/fixedChunker';
import { chunkStructureAware } from '../src/lib/rag/chunkers/structureChunker';
import { createEmbeddingProvider, getOrGenerateEmbedding } from '../src/lib/ai/embeddings';
import { query, dbPool } from '../src/lib/db/client';

export async function runIngestion(options: { force?: boolean; limit?: number } = {}) {
  const startTime = Date.now();
  const corpusDir = path.resolve(__dirname, '..', 'knowledge-base');
  const embeddingProvider = createEmbeddingProvider();

  console.log(`\n=== Starting Grounded Document Ingestion ===`);
  console.log(`Corpus Directory: ${corpusDir}`);
  console.log(`Embedding Provider: ${embeddingProvider.providerName}`);
  console.log(`Embedding Model: ${embeddingProvider.modelId} (${embeddingProvider.dimensions} dims)`);
  console.log(`Force Re-ingest: ${Boolean(options.force)}`);

  const allFiles: string[] = [];
  const subdirs = fs.readdirSync(corpusDir).filter(f => fs.statSync(path.join(corpusDir, f)).isDirectory());
  for (const sub of subdirs) {
    const dirPath = path.join(corpusDir, sub);
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md') || f.endsWith('.pdf'));
    for (const file of files) {
      allFiles.push(path.join(dirPath, file));
    }
  }

  const filesToProcess = options.limit ? allFiles.slice(0, options.limit) : allFiles;
  console.log(`Found ${allFiles.length} total documents. Processing ${filesToProcess.length} documents...\n`);

  let processedCount = 0;
  let skippedCount = 0;
  let totalChunksInserted = 0;

  for (let i = 0; i < filesToProcess.length; i++) {
    const filePath = filesToProcess[i];
    const doc = await loadDocument(filePath, corpusDir);

    // 1. Idempotency Check: check document hash and existing chunks for THIS model
    const existing = await query(
      `SELECT id, content_hash, ingestion_status FROM documents WHERE id = $1`,
      [doc.id]
    );

    const existingChunks = await query(
      `SELECT COUNT(*)::int AS count FROM chunks 
       WHERE document_id = $1 AND model_id = $2 AND dimensions = $3`,
      [doc.id, embeddingProvider.modelId, embeddingProvider.dimensions]
    );
    const hasModelChunks = (existingChunks[0]?.count || 0) > 0;

    if (
      !options.force &&
      existing.length > 0 &&
      existing[0].content_hash === doc.content_hash &&
      hasModelChunks
    ) {
      skippedCount++;
      process.stdout.write(`[${i + 1}/${filesToProcess.length}] SKIP (Unchanged for ${embeddingProvider.modelId}): ${doc.id}\r`);
      continue;
    }

    // 2. Upsert document
    await query(
      `INSERT INTO documents (
        id, title, category, department, version, status, effective_date, 
        supersedes, file_path, file_type, content_hash, ingestion_status, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PROCESSING', NOW())
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        category = EXCLUDED.category,
        department = EXCLUDED.department,
        version = EXCLUDED.version,
        status = EXCLUDED.status,
        effective_date = EXCLUDED.effective_date,
        supersedes = EXCLUDED.supersedes,
        file_path = EXCLUDED.file_path,
        file_type = EXCLUDED.file_type,
        content_hash = EXCLUDED.content_hash,
        ingestion_status = 'PROCESSING',
        updated_at = NOW()`,
      [
        doc.id, doc.title, doc.category, doc.department, doc.version, doc.status,
        doc.effective_date, doc.supersedes || null, doc.file_path, doc.file_type, doc.content_hash
      ]
    );

    // 3. Invalidate existing chunks for this specific document and model
    await query(
      `DELETE FROM chunks WHERE document_id = $1 AND model_id = $2 AND dimensions = $3`,
      [doc.id, embeddingProvider.modelId, embeddingProvider.dimensions]
    );

    // 4. Generate chunks for both strategies
    const fixedChunks = chunkFixedSize(doc);
    const structureChunks = chunkStructureAware(doc);
    const allChunks = [...fixedChunks, ...structureChunks];

    // 5. Embed and persist
    const colName = embeddingProvider.dimensions === 384 ? 'embedding_384' : 'embedding_768';
    for (const chunk of allChunks) {
      const vector = await getOrGenerateEmbedding(
        chunk.content,
        chunk.content_hash,
        embeddingProvider
      );

      const vectorString = `[${vector.join(',')}]`;

      await query(
        `INSERT INTO chunks (
          document_id, strategy, chunk_index, content, section_title, 
          page_number, token_count, content_hash, model_id, dimensions, corpus_version, metadata, ${colName}
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::vector)`,
        [
          chunk.document_id, chunk.strategy, chunk.chunk_index, chunk.content,
          chunk.section_title, chunk.page_number || null, chunk.token_count,
          chunk.content_hash, embeddingProvider.modelId, embeddingProvider.dimensions,
          'v1.0', JSON.stringify(chunk.metadata), vectorString
        ]
      );
      totalChunksInserted++;
    }

    // 6. Mark PROCESSED
    await query(
      `UPDATE documents SET ingestion_status = 'PROCESSED', updated_at = NOW() WHERE id = $1`,
      [doc.id]
    );

    processedCount++;
    const percent = Math.round(((i + 1) / filesToProcess.length) * 100);
    process.stdout.write(`[${i + 1}/${filesToProcess.length}] (${percent}%) Processed: ${doc.id} (${allChunks.length} chunks)\n`);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n=== Ingestion Completed in ${durationSec}s ===`);
  console.log(`- Documents Processed: ${processedCount}`);
  console.log(`- Documents Skipped (Idempotent): ${skippedCount}`);
  console.log(`- Total Chunks Persisted: ${totalChunksInserted}`);

  return { processedCount, skippedCount, totalChunksInserted };
}

if (require.main === module) {
  runIngestion()
    .then(async () => {
      await dbPool.end();
      process.exit(0);
    })
    .catch(async err => {
      console.error('Ingestion failed:', err);
      await dbPool.end();
      process.exit(1);
    });
}

