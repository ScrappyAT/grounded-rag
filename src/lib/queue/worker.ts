import { Worker, Job } from 'bullmq';
import * as path from 'path';
import { redisConnection } from './client';
import { INGESTION_QUEUE_NAME, IngestionJobData } from './ingestionQueue';
import { loadDocument } from '../rag/loader';
import { chunkFixedSize } from '../rag/chunkers/fixedChunker';
import { chunkStructureAware } from '../rag/chunkers/structureChunker';
import { createEmbeddingProvider, getOrGenerateEmbedding } from '../ai/embeddings';
import { query } from '../db/client';

export interface IngestionResult {
  documentId: string;
  skipped: boolean;
  fixedChunksCount: number;
  structureChunksCount: number;
  totalChunksCount: number;
}

export async function processIngestionJob(
  job: Job<IngestionJobData>,
  embeddingProvider = createEmbeddingProvider()
): Promise<IngestionResult> {
  const { filePath, forceReingest } = job.data;
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);

  await job.updateProgress(10);
  const loadedDoc = await loadDocument(absPath);

  // 1. Idempotency Check: check if document exists with identical hash AND has chunks for this model
  const existingDocs = await query(
    `SELECT id, content_hash, ingestion_status FROM documents WHERE id = $1`,
    [loadedDoc.id]
  );

  const existingModelChunks = await query(
    `SELECT COUNT(*)::int AS count FROM chunks 
     WHERE document_id = $1 AND model_id = $2 AND dimensions = $3`,
    [loadedDoc.id, embeddingProvider.modelId, embeddingProvider.dimensions]
  );
  const hasModelChunks = (existingModelChunks[0]?.count || 0) > 0;

  if (
    !forceReingest &&
    existingDocs.length > 0 &&
    existingDocs[0].content_hash === loadedDoc.content_hash &&
    hasModelChunks
  ) {
    await job.updateProgress(100);
    return {
      documentId: loadedDoc.id,
      skipped: true,
      fixedChunksCount: 0,
      structureChunksCount: 0,
      totalChunksCount: 0,
    };
  }

  await job.updateProgress(25);

  // 2. Upsert document in `documents` table
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
      loadedDoc.id,
      loadedDoc.title,
      loadedDoc.category,
      loadedDoc.department,
      loadedDoc.version,
      loadedDoc.status,
      loadedDoc.effective_date,
      loadedDoc.supersedes || null,
      loadedDoc.file_path,
      loadedDoc.file_type,
      loadedDoc.content_hash,
    ]
  );

  // 3. Invalidate/delete existing chunks for this specific document and model
  await query(
    `DELETE FROM chunks WHERE document_id = $1 AND model_id = $2 AND dimensions = $3`,
    [loadedDoc.id, embeddingProvider.modelId, embeddingProvider.dimensions]
  );

  await job.updateProgress(40);

  // 4. Generate chunks for BOTH strategies
  const fixedChunks = chunkFixedSize(loadedDoc);
  const structureChunks = chunkStructureAware(loadedDoc);
  const allChunks = [...fixedChunks, ...structureChunks];

  await job.updateProgress(60);

  // 5. Generate embeddings and persist chunks
  const colName = embeddingProvider.dimensions === 384 ? 'embedding_384' : 'embedding_768';
  let processedChunks = 0;
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
        chunk.document_id,
        chunk.strategy,
        chunk.chunk_index,
        chunk.content,
        chunk.section_title,
        chunk.page_number || null,
        chunk.token_count,
        chunk.content_hash,
        embeddingProvider.modelId,
        embeddingProvider.dimensions,
        'v1.0',
        JSON.stringify(chunk.metadata),
        vectorString,
      ]
    );

    processedChunks++;
    const progressPercent = Math.min(95, 60 + Math.round((processedChunks / allChunks.length) * 35));
    await job.updateProgress(progressPercent);
  }

  // 6. Mark document as PROCESSED
  await query(
    `UPDATE documents SET ingestion_status = 'PROCESSED', updated_at = NOW() WHERE id = $1`,
    [loadedDoc.id]
  );

  await job.updateProgress(100);

  return {
    documentId: loadedDoc.id,
    skipped: false,
    fixedChunksCount: fixedChunks.length,
    structureChunksCount: structureChunks.length,
    totalChunksCount: allChunks.length,
  };
}

export function createIngestionWorker(concurrency = 2) {
  const worker = new Worker<IngestionJobData>(
    INGESTION_QUEUE_NAME,
    async job => {
      try {
        return await processIngestionJob(job);
      } catch (err: any) {
        // Mark document as FAILED
        if (job.data?.filePath) {
          try {
            const docId = path.basename(job.data.filePath).replace(/\.(md|pdf)$/, '');
            await query(
              `UPDATE documents SET ingestion_status = 'FAILED', updated_at = NOW() WHERE id = $1`,
              [docId]
            );
          } catch (_) {}
        }
        throw err;
      }
    },
    {
      connection: redisConnection,
      concurrency,
    }
  );

  worker.on('completed', job => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(`[Worker] Job ${job.id} completed for ${job.data.filePath}`);
    }
  });

  worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

// Standalone execution: tsx src/lib/queue/worker.ts
if (require.main === module) {
  console.log('[Worker] Starting Grounded BullMQ Ingestion Worker...');
  const worker = createIngestionWorker(2);

  process.on('SIGINT', async () => {
    console.log('[Worker] Shutting down gracefully...');
    await worker.close();
    process.exit(0);
  });
}

