import { NextResponse } from 'next/server';
import { getQueueMetrics, ingestionQueue } from '@/lib/queue/ingestionQueue';
import { query } from '@/lib/db/client';
import { verifyAdminAuth, unauthorizedResponse } from '@/lib/auth/adminAuth';

export async function GET(req: Request) {
  // In production or when ADMIN_API_KEY is configured, restrict queue and job telemetry to administrators
  if (process.env.NODE_ENV === 'production' || process.env.ADMIN_API_KEY) {
    if (!verifyAdminAuth(req)) {
      return unauthorizedResponse('Valid ADMIN_API_KEY required to inspect ingestion jobs and queue metrics.');
    }
  }

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
    const rawMsg = err?.message || 'Unknown internal error';
    const safeLogMsg = rawMsg
      .replace(/sk-[a-zA-Z0-9_\-]+/g, '[REDACTED]')
      .replace(/postgres(ql)?:\/\/[^@\s]+@/g, 'postgresql://[REDACTED]@');
    console.error('[Jobs API Error]', safeLogMsg);

    return NextResponse.json(
      { error: 'An internal error occurred while retrieving job status.' },
      { status: 500 }
    );
  }
}
