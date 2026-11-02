import { NextResponse } from 'next/server';
import { query } from '@/lib/db/client';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '20', 10));

    const rows = await query(`
      SELECT 
        id,
        query_text,
        strategy,
        top_k,
        model_id,
        dimensions,
        similarity_scores,
        refused,
        refusal_reason,
        answer_text,
        cited_document_ids,
        latency_ms,
        prompt_tokens,
        completion_tokens,
        estimated_cost_usd,
        user_ip,
        created_at
      FROM query_logs
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);

    const stats = await query(`
      SELECT 
        COUNT(*)::int AS total_queries,
        COUNT(*) FILTER (WHERE refused = true)::int AS total_refused,
        ROUND(AVG(latency_ms)::numeric, 1) AS avg_latency_ms,
        SUM(prompt_tokens + completion_tokens)::int AS total_tokens,
        ROUND(SUM(estimated_cost_usd)::numeric, 6) AS total_cost_usd
      FROM query_logs
    `);

    return NextResponse.json({
      summary: stats[0] || {},
      logs: rows,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

