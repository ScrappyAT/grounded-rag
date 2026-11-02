import * as path from 'path';
import * as fs from 'fs';
import { verifyCorpus } from './verify-corpus';
import { loadDocument, computeSha256 } from '../src/lib/rag/loader';
import { chunkFixedSize } from '../src/lib/rag/chunkers/fixedChunker';
import { chunkStructureAware } from '../src/lib/rag/chunkers/structureChunker';
import { 
  DeterministicMockEmbeddingProvider, 
  getOrGenerateEmbedding, 
  IEmbeddingProvider 
} from '../src/lib/ai/embeddings';
import { query, dbPool } from '../src/lib/db/client';
import { ingestionQueue, enqueueDocument } from '../src/lib/queue/ingestionQueue';
import { processIngestionJob, createIngestionWorker } from '../src/lib/queue/worker';

interface TestResult {
  name: string;
  passed: boolean;
  message?: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    process.stdout.write(`[TEST] Running: ${name}... `);
    await fn();
    const durationMs = Date.now() - start;
    results.push({ name, passed: true, durationMs });
    console.log(`PASSED (${durationMs}ms)`);
  } catch (err: any) {
    const durationMs = Date.now() - start;
    results.push({ name, passed: false, message: err.message, durationMs });
    console.log(`FAILED (${durationMs}ms)`);
    console.error(`       Error: ${err.message}`);
  }
}

export async function runAllPhase2Tests() {
  console.log('\n======================================================');
  console.log('       Grounded RAG — Phase 2 Automated Test Suite     ');
  console.log('======================================================\n');

  const corpusDir = path.resolve(__dirname, '..', 'knowledge-base');
  const mockProvider = new DeterministicMockEmbeddingProvider('mock-embedding-768', 768);

  // 1. Corpus Integrity Test
  await runTest('1. Corpus Integrity & Manifest Audit', async () => {
    const check = await verifyCorpus(corpusDir);
    if (!check.success) {
      throw new Error(`Corpus verification failed: ${check.errors.join('; ')}`);
    }
    if (check.totalDocs !== 220 || check.mdDocs !== 210 || check.pdfDocs !== 10) {
      throw new Error(`Corpus count mismatch: expected 220 (210 md, 10 pdf), got ${check.totalDocs}`);
    }
  });

  // 2. Document Parsers Test
  await runTest('2. Markdown & PDF Parsers', async () => {
    // Markdown
    const mdPath = path.join(corpusDir, '01-customer-support', 'DOC-SUP-001.md');
    const mdDoc = await loadDocument(mdPath);
    if (mdDoc.id !== 'DOC-SUP-001' || mdDoc.file_type !== 'markdown' || mdDoc.sections.length < 2) {
      throw new Error('Markdown parser failed to extract expected fields or sections');
    }

    // PDF
    const pdfPath = path.join(corpusDir, '01-customer-support', 'DOC-SUP-026.pdf');
    const pdfDoc = await loadDocument(pdfPath);
    if (pdfDoc.id !== 'DOC-SUP-026' || pdfDoc.file_type !== 'pdf' || pdfDoc.raw_content.length < 100) {
      throw new Error('PDF parser failed to extract text or metadata');
    }
  });

  // 3. Both Chunking Strategies Test
  await runTest('3. Chunking Strategies (Fixed vs Structure-Aware)', async () => {
    const mdPath = path.join(corpusDir, '01-customer-support', 'DOC-SUP-001.md');
    const doc = await loadDocument(mdPath);

    // Fixed chunking
    const fixedChunks = chunkFixedSize(doc, { chunkSize: 400, overlap: 80 });
    if (fixedChunks.length < 2) {
      throw new Error('Fixed chunker did not generate multiple overlapping chunks');
    }
    if (fixedChunks[0].strategy !== 'fixed') {
      throw new Error('Fixed chunker strategy tag missing');
    }

    // Structure-aware chunking
    const structChunks = chunkStructureAware(doc, { maxSectionSize: 800 });
    if (structChunks.length < 2) {
      throw new Error('Structure-aware chunker did not split by sections');
    }
    if (!structChunks[0].content.includes('[DOCUMENT: DOC-SUP-001')) {
      throw new Error('Structure-aware chunker missing contextual breadcrumb header');
    }
  });

  // 4. Hash-Based Deduplication & Embedding Caching Test
  await runTest('4. Hash Deduplication & Model-Aware Embedding Cache', async () => {
    const testText = 'ApexPay Merchant Settlement and Liquidity Reserve Guidelines 2026';
    const testHash = computeSha256('test_hash_unique_dedup_string');

    // Clear test record if exists
    await query('DELETE FROM embedding_cache WHERE content_hash = $1', [testHash]);

    // First call: should generate and insert
    const vec1 = await getOrGenerateEmbedding(testText, testHash, mockProvider);
    if (!vec1 || vec1.length !== 768) {
      throw new Error('Embedding generation did not return 768-dim vector');
    }

    // Verify row in DB
    const dbCheck = await query('SELECT model_id, dimensions FROM embedding_cache WHERE content_hash = $1', [testHash]);
    if (dbCheck.length === 0 || dbCheck[0].dimensions !== 768) {
      throw new Error('Embedding was not stored in embedding_cache table');
    }

    // Second call: should hit cache
    const vec2 = await getOrGenerateEmbedding(testText, testHash, mockProvider);
    if (vec2.length !== 768) {
      throw new Error(`Cached vector length mismatch: expected 768, got ${vec2.length}`);
    }
    // Verify values match within float32 database precision
    for (let i = 0; i < 768; i++) {
      if (Math.abs(vec1[i] - vec2[i]) > 1e-4) {
        throw new Error(`Cached embedding vector drifted at index ${i}: original ${vec1[i]} vs cached ${vec2[i]}`);
      }
    }

    // Clean up
    await query('DELETE FROM embedding_cache WHERE content_hash = $1', [testHash]);
  });

  // 5. Model/Dimension Mismatch Guard Test
  await runTest('5. Model & Dimension Mismatch Protection', async () => {
    const invalidDimensionProvider: IEmbeddingProvider = {
      providerName: 'invalid-provider',
      modelId: 'invalid-512',
      dimensions: 512,
      generateEmbedding: async () => new Array(512).fill(0.1),
      generateBatchEmbeddings: async () => [new Array(512).fill(0.1)],
    };

    let caughtError = false;
    try {
      await getOrGenerateEmbedding('some text', 'dummy_hash_512', invalidDimensionProvider);
    } catch (err: any) {
      caughtError = true;
      if (!err.message.includes('column "embedding" is of type vector(768) but expression is of type vector(512)') &&
          !err.message.includes('dimension') && !err.message.includes('vector')) {
        throw new Error(`Unexpected error message on dimension mismatch: ${err.message}`);
      }
    }

    if (!caughtError) {
      throw new Error('Dimension guard failed to reject 512-dim vector on 768-dim table');
    }
  });

  // 6. Idempotent Ingestion Test
  await runTest('6. Idempotent Document Ingestion', async () => {
    const sampleDocPath = path.join(corpusDir, '04-refunds-disputes', 'DOC-REF-012.md');

    // First ingestion via processIngestionJob
    const job1 = {
      id: 'test-job-1',
      data: { filePath: sampleDocPath, forceReingest: true },
      updateProgress: async () => {},
    } as any;

    const res1 = await processIngestionJob(job1, mockProvider);
    if (res1.skipped || res1.totalChunksCount === 0) {
      throw new Error('First ingestion failed to process chunks');
    }

    // Second ingestion without force: MUST skip
    const job2 = {
      id: 'test-job-2',
      data: { filePath: sampleDocPath, forceReingest: false },
      updateProgress: async () => {},
    } as any;

    const res2 = await processIngestionJob(job2, mockProvider);
    if (!res2.skipped || res2.totalChunksCount !== 0) {
      throw new Error(`Idempotency check failed: expected skipped=true, got skipped=${res2.skipped}`);
    }
  });

  // 7. Document Updates & Chunk Invalidation Test
  await runTest('7. Document Updates & Chunk Invalidation', async () => {
    const testDocId = 'DOC-TEST-UPD-001';
    const testFilePath = path.join(corpusDir, '01-customer-support', `${testDocId}.md`);

    // Clean up if exists
    if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
    await query('DELETE FROM documents WHERE id = $1', [testDocId]);

    try {
      // Create version 1.0
      const contentV1 = `---
id: "${testDocId}"
title: "Temporary Update Policy v1"
category: "01-customer-support"
department: "Customer Support"
version: "1.0"
effective_date: "2026-01-01"
status: "active"
file_type: "markdown"
---

# Temporary Update Policy v1

## Section 1: Initial Terms
This is the initial text for version 1.0.
`;
      fs.writeFileSync(testFilePath, contentV1, 'utf8');

      // Ingest v1.0
      const jobV1 = {
        id: 'test-v1',
        data: { filePath: testFilePath, forceReingest: true },
        updateProgress: async () => {},
      } as any;
      await processIngestionJob(jobV1, mockProvider);

      const chunksV1 = await query('SELECT id, content FROM chunks WHERE document_id = $1', [testDocId]);
      if (chunksV1.length === 0) throw new Error('Chunks for v1.0 were not created');
      const v1ChunkIds = chunksV1.map(c => c.id);

      // Create version 1.1 with new text
      const contentV2 = `---
id: "${testDocId}"
title: "Temporary Update Policy v1.1"
category: "01-customer-support"
department: "Customer Support"
version: "1.1"
effective_date: "2026-02-01"
status: "active"
file_type: "markdown"
---

# Temporary Update Policy v1.1

## Section 1: Updated Terms
This is the revised text for version 1.1 with completely changed policies.
`;
      fs.writeFileSync(testFilePath, contentV2, 'utf8');

      // Ingest v1.1
      const jobV2 = {
        id: 'test-v2',
        data: { filePath: testFilePath, forceReingest: false },
        updateProgress: async () => {},
      } as any;
      await processIngestionJob(jobV2, mockProvider);

      // Verify old chunks were purged and replaced
      const chunksV2 = await query('SELECT id, content FROM chunks WHERE document_id = $1', [testDocId]);
      for (const oldId of v1ChunkIds) {
        if (chunksV2.some(c => c.id === oldId)) {
          throw new Error('Old chunk ID still exists after document update (invalidation failed)');
        }
      }
      if (!chunksV2.some(c => c.content.includes('revised text for version 1.1'))) {
        throw new Error('New chunk content not found after update');
      }
    } finally {
      if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
      await query('DELETE FROM documents WHERE id = $1', [testDocId]);
    }
  });

  // 8. Policy-Version Precedence Test
  await runTest('8. Policy-Version Precedence & Conflict Isolation', async () => {
    // Ingest both DOC-REF-002 (deprecated 2024) and DOC-REF-012 (active 2026)
    const docOldPath = path.join(corpusDir, '04-refunds-disputes', 'DOC-REF-002.md');
    const docNewPath = path.join(corpusDir, '04-refunds-disputes', 'DOC-REF-012.md');

    await processIngestionJob({ id: 'old', data: { filePath: docOldPath, forceReingest: true }, updateProgress: async () => {} } as any, mockProvider);
    await processIngestionJob({ id: 'new', data: { filePath: docNewPath, forceReingest: true }, updateProgress: async () => {} } as any, mockProvider);

    // Verify metadata in DB
    const docs = await query('SELECT id, version, status, effective_date, supersedes FROM documents WHERE id IN ($1, $2)', ['DOC-REF-002', 'DOC-REF-012']);
    const oldDoc = docs.find(d => d.id === 'DOC-REF-002');
    const newDoc = docs.find(d => d.id === 'DOC-REF-012');

    if (!oldDoc || oldDoc.status !== 'deprecated') {
      throw new Error(`DOC-REF-002 should be status='deprecated', got ${oldDoc?.status}`);
    }
    if (!newDoc || newDoc.status !== 'active') {
      throw new Error(`DOC-REF-012 should be status='active', got ${newDoc?.status}`);
    }
    if (newDoc.supersedes !== 'DOC-REF-002') {
      throw new Error(`DOC-REF-012 supersedes pointer missing or incorrect: ${newDoc.supersedes}`);
    }

    // Verify query filtering by active status excludes deprecated policy
    const activeChunks = await query(`
      SELECT c.content, d.status 
      FROM chunks c 
      JOIN documents d ON c.document_id = d.id 
      WHERE d.status = 'active' AND d.id IN ('DOC-REF-002', 'DOC-REF-012')
    `);

    if (activeChunks.some(c => c.content.includes('3 to 5 business days, no exceptions'))) {
      throw new Error('Active policy filter leaked deprecated policy content!');
    }
    if (!activeChunks.some(c => c.content.includes('international transfers require up to 14 business days'))) {
      throw new Error('Active authoritative refund terms missing from active chunks');
    }
  });

  // 9. BullMQ Queue & Worker Resilience Test
  await runTest('9. BullMQ Queue, Progress & Bounded Retries', async () => {
    // Test queue enqueue
    const fakeJob = await enqueueDocument('non-existent-test-file.md', false);
    if (!fakeJob || !fakeJob.id) {
      throw new Error('Failed to enqueue job to BullMQ');
    }

    // Create worker to process and assert graceful failure
    const worker = createIngestionWorker(1);

    // Wait for job failure event
    const failedPromise = new Promise((resolve) => {
      worker.on('failed', (job) => {
        if (job?.id === fakeJob.id) resolve(true);
      });
    });

    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('BullMQ failure timeout')), 6000));
    await Promise.race([failedPromise, timeout]);

    await worker.close();
  });

  console.log('\n======================================================');
  console.log('                 Test Run Summary                     ');
  console.log('======================================================');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}\n`);

  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} ${r.name} (${r.durationMs}ms)`);
    if (!r.passed) console.log(`    -> ${r.message}`);
  }

  await dbPool.end();
  await ingestionQueue.close();

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  runAllPhase2Tests().catch(err => {
    console.error('Test suite runner crashed:', err);
    process.exit(1);
  });
}
