import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6395';

export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

redisConnection.on('error', err => {
  if (process.env.LOG_LEVEL === 'debug') {
    console.error('[Redis Error]', err.message);
  }
});

