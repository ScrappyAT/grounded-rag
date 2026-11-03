import { Pool, PoolConfig } from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5550/grounded_rag';

const isRemoteCloudDb = Boolean(
  connectionString.includes('neon.tech') ||
  connectionString.includes('render.com') ||
  connectionString.includes('railway.app') ||
  process.env.PGSSLMODE === 'require' ||
  (process.env.NODE_ENV === 'production' && !connectionString.includes('127.0.0.1') && !connectionString.includes('localhost'))
);

const poolConfig: PoolConfig = {
  connectionString,
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

// Secure Cloud Database Connectivity:
// Strictly enforces valid TLS certificate verification (rejectUnauthorized: true).
// Does NOT disable certificate verification.
if (isRemoteCloudDb) {
  poolConfig.ssl = {
    rejectUnauthorized: true,
  };
}

export const dbPool = new Pool(poolConfig);

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const start = Date.now();
  const res = await dbPool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.LOG_LEVEL === 'debug') {
    console.log('[SQL]', { text, duration, rows: res.rowCount });
  }
  return res.rows as T[];
}
