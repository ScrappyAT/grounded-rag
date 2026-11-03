import { NextResponse } from 'next/server';
import { query } from '@/lib/db/client';
import { verifyAdminAuth, unauthorizedResponse } from '@/lib/auth/adminAuth';

function maskIp(ip: string | null | undefined): string {
  if (!ip) return 'anonymous';
  if (ip === '127.0.0.1' || ip === '::1') return 'localhost';
  // Mask last octet of IPv4
  if (ip.includes('.')) {
    return ip.replace(/\.\d+$/, '.xxx');
  }
  // Mask IPv6 suffix
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + ':xxxx:xxxx';
  }
  return 'masked';
}

export async function GET(req: Request) {
  // In production or when ADMIN_API_KEY is configured, restrict audit logs to administrators
  if (process.env.NODE_ENV === 'production' || process.env.ADMIN_API_KEY) {
    if (!verifyAdminAuth(req)) {
      return unauthorizedResponse('Valid ADMIN_API_KEY required to inspect audit logs.');
    }
  }

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

    // Anonymize user IP addresses for privacy compliance
    const sanitizedRows = rows.map((r: any) => ({
      ...r,
      user_ip: maskIp(r.user_ip),
    }));

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
      logs: sanitizedRows,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

