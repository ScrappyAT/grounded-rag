import { Pool, type PoolConfig } from 'pg';

export interface DbSslConfig {
  rejectUnauthorized?: boolean;
}

/**
 * Extracts hostname from PostgreSQL connection string.
 */
export function parseDbHost(connStr: string): string {
  try {
    const parsed = new URL(connStr);
    return parsed.hostname;
  } catch {
    const match = connStr.match(/@([^:/]+)/);
    return match ? match[1] : '';
  }
}

/**
 * Determines whether a database host is a remote cloud database
 * (e.g. Neon, Render, Railway, Supabase, or external FQDN)
 * versus a local development / local Docker container host.
 */
export function isRemoteDatabaseHost(host: string): boolean {
  if (!host) return false;
  const h = host.toLowerCase().trim();

  // Explicit local hosts and loopbacks
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0'
  ) {
    return false;
  }

  // Local Docker or internal domain suffixes
  if (
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.includes('docker')
  ) {
    return false;
  }

  // Standard Docker service names without dots (e.g., 'grounded-postgres', 'postgres', 'db')
  if (!h.includes('.')) {
    return false;
  }

  return true;
}

/**
 * Resolves explicit SSL configuration for PostgreSQL connections.
 *
 * Rules:
 * 1. Local Docker / loopback connections:
 *    - Respects PGSSLMODE=disable (returns false) for local Docker testing without SSL.
 *    - Default for local non-SSL containers is false (disabled).
 * 2. Remote production databases (especially Neon):
 *    - Strictly enforces TLS certificate verification (rejectUnauthorized: true).
 * 3. Insecure override prevention:
 *    - PGSSLMODE=disable or ?sslmode=disable is STRICTLY PROHIBITED for remote production databases.
 *    - Throws an explicit SecurityError if an insecure override is attempted on a remote database.
 *    - Never returns rejectUnauthorized: false under any circumstances.
 */
export function resolveDbSslConfig(
  connStr: string,
  pgSslMode = process.env.PGSSLMODE
): DbSslConfig | false {
  const host = parseDbHost(connStr);
  const isRemote = isRemoteDatabaseHost(host) || connStr.includes('neon.tech');

  // Detect explicit sslmode setting from environment or connection string query param
  const envSslMode = pgSslMode?.trim().toLowerCase();
  let urlSslMode: string | undefined = undefined;
  try {
    const parsed = new URL(connStr);
    const modeParam = parsed.searchParams.get('sslmode');
    if (modeParam) urlSslMode = modeParam.trim().toLowerCase();
  } catch {}

  const requestedSslMode = envSslMode || urlSslMode;

  // 1. Insecure override check for remote production databases (Neon, etc.)
  if (isRemote) {
    const isInsecureOverride =
      envSslMode === 'disable' ||
      urlSslMode === 'disable' ||
      envSslMode === 'no-verify' ||
      urlSslMode === 'no-verify' ||
      envSslMode === 'allow' ||
      urlSslMode === 'allow' ||
      envSslMode === 'prefer' ||
      urlSslMode === 'prefer';

    if (isInsecureOverride) {
      throw new Error(
        `[Database Security] Insecure SSL override (PGSSLMODE=${envSslMode || urlSslMode} or sslmode=${urlSslMode || envSslMode}) is strictly prohibited for remote database connections (${host}). Remote databases require verified TLS.`
      );
    }
    // Remote databases always enforce verified TLS
    return {
      rejectUnauthorized: true,
    };
  }

  // 2. Local Docker testing & local development
  if (requestedSslMode === 'disable') {
    return false; // Explicitly disable SSL for local Docker testing
  }

  if (
    requestedSslMode === 'require' ||
    requestedSslMode === 'verify-ca' ||
    requestedSslMode === 'verify-full'
  ) {
    return {
      rejectUnauthorized: true,
    };
  }

  // Default for local hosts (localhost, 127.0.0.1, grounded-postgres)
  return false;
}

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5550/grounded_rag';

const sslConfig = resolveDbSslConfig(connectionString, process.env.PGSSLMODE);

const poolConfig: PoolConfig = {
  connectionString,
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: sslConfig,
};

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
