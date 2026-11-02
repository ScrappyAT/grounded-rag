import { NextResponse } from 'next/server';
import { getQueueMetrics, ingestionQueue } from '@/lib/queue/ingestionQueue';
import { query } from '@/lib/db/client';

export async function GET() {
  try {
    const queueMetrics = await getQueueMetrics();

    // Query database ingestion counts
    const [docStats, chunkStats, cacheStats] = await Promise.all([
      query(`
        SELECT 
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE ingestion_status = 'PROCESSED')::int AS processed,
          COUNT(*) FILTER (WHERE ingestion_status = 'FAILED')::int AS failed,
          COUNT(*) FILTER (WHERE ingestion_status = 'PROCESSING')::int AS processing
        FROM documents
      `),
      query(`
        SELECT 
          COUNT(*)::int AS total_chunks,
          COUNT(*) FILTER (WHERE strategy = 'fixed')::int AS fixed_chunks,
          COUNT(*) FILTER (WHERE strategy = 'structure_aware')::int AS structure_chunks
        FROM chunks
      `),
      query(`
        SELECT COUNT(*)::int AS cached_embeddings FROM embedding_cache
      `),
    ]);

    // Fetch active jobs and recent completed jobs
    const activeJobs = await ingestionQueue.getActive();
    const activeProgress = activeJobs.map(j => ({
      id: j.id,
      file: j.data.filePath,
      progress: j.progress,
    }));

    return NextResponse.json({
      status: 'ok',
      queue: queueMetrics,
      database: {
        documents: docStats[0] || {},
        chunks: chunkStats[0] || {},
        cache: cacheStats[0] || {},
      },
      activeJobs: activeProgress,
    });
  } catch (err: any) {
    return NextResponse.json(
      { status: 'error', message: err.message },
      { status: 500 }
    );
  }
}

