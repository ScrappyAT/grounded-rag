import { redisConnection } from '../queue/client';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

export async function checkRateLimit(
  identifier: string,
  limitPerMinute = 15
): Promise<RateLimitResult> {
  const windowSec = 60;
  const key = `ratelimit:${identifier}`;

  try {
    const current = await redisConnection.incr(key);
    if (current === 1) {
      await redisConnection.expire(key, windowSec);
    }
    const ttl = await redisConnection.ttl(key);

    return {
      allowed: current <= limitPerMinute,
      remaining: Math.max(0, limitPerMinute - current),
      resetSeconds: ttl > 0 ? ttl : windowSec,
    };
  } catch (err) {
    // If Redis is momentarily unavailable, fallback to allowing request
    console.warn('[RateLimiter] Redis unavailable, permitting request:', err);
    return {
      allowed: true,
      remaining: limitPerMinute,
      resetSeconds: windowSec,
    };
  }
}

