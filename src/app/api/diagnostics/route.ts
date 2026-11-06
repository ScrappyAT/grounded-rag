import { NextResponse } from 'next/server';
import { redisConnection } from '@/lib/queue/client';
import { verifyAdminAuth, unauthorizedResponse } from '@/lib/auth/adminAuth';

export const dynamic = 'force-dynamic';

/**
 * Administrative diagnostic endpoint for Redis connectivity.
 * Protected by ADMIN_API_KEY.
 * Never modifies rate-limit or budget counters.
 * Never exposes credentials, connection strings, key names, or financial data.
 */
export async function GET(req: Request) {
  // Enforce administrative authorization strictly before any Redis interaction
  if (!verifyAdminAuth(req)) {
    return unauthorizedResponse('Valid ADMIN_API_KEY required for administrative diagnostics.');
  }

  const startTime = Date.now();
  let connected = false;
  let latencyMs = -1;
  let redisStatus = 'disconnected';
  let timer: NodeJS.Timeout | undefined;

  try {
    const pingPromise = redisConnection.ping();
    // Attach passive catch handler to absorb late rejections if timeout triggers first
    pingPromise.catch(() => {});

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis ping timeout')), 2500);
    });

    const pingResponse = await Promise.race([pingPromise, timeoutPromise]);
    if (pingResponse === 'PONG') {
      connected = true;
      latencyMs = Date.now() - startTime;
      redisStatus = 'connected';
    }
  } catch {
    redisStatus = 'unreachable';
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }

  const payload = {
    status: connected ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    redis: {
      status: redisStatus,
      connected,
      connectionState: redisConnection.status,
      ...(connected ? { latencyMs } : {}),
      readOnly: process.env.READ_ONLY_MODE === 'true',
    },
  };

  return NextResponse.json(payload, { status: connected ? 200 : 503 });
}
