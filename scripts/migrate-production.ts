import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

export function parseDbHost(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    return u.hostname;
  } catch {
    const match = urlStr.match(/@([^:/]+)/);
    return match ? match[1] : '';
  }
}

export function sanitizeDbUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return rawUrl.replace(/:([^:@]+)@/, ':****@');
  }
}

export function validateProductionDbTarget(targetEnv: string, dbUrl: string): { valid: boolean; error?: string; host: string } {
  const normEnv = (targetEnv || '').toLowerCase().trim();
  if (!normEnv || (normEnv !== 'production' && normEnv !== 'cloud')) {
    return {
      valid: false,
      error: 'TARGET_ENV must be explicitly set to "production" or "cloud" to run production migration.',
      host: '',
    };
  }

  if (!dbUrl || dbUrl.trim() === '') {
    return {
      valid: false,
      error: 'DATABASE_URL is empty or undefined.',
      host: '',
    };
  }

  const host = parseDbHost(dbUrl);

  if (host === 'localhost' || host === '127.0.0.1' || host.includes('local') || dbUrl.includes(':5550')) {
    return {
      valid: false,
      error: `TARGET_ENV is "${targetEnv}", but DATABASE_URL points to a local database (${host}). Localhost targets are strictly rejected.`,
      host,
    };
  }

  if (normEnv === 'production') {
    if (!host.endsWith('.neon.tech')) {
      return {
        valid: false,
        error: `TARGET_ENV is "production", but host "${host}" is not a verified Neon PostgreSQL host (*.neon.tech). Rejecting unexpected database providers.`,
        host,
      };
    }
  }

  return { valid: true, host };
}

async function runProductionMigration() {
  console.log('======================================================');
  console.log('   Grounded RAG — Production Migration & Seed Runner  ');
  console.log('======================================================\n');

  const targetEnv = process.env.TARGET_ENV || '';
  const dbUrl = process.env.DATABASE_URL || '';

  // 1. Strict Target Validation Guardrail
  const validation = validateProductionDbTarget(targetEnv, dbUrl);
  if (!validation.valid) {
    console.error(`SAFETY BLOCKED: ${validation.error}\n`);
    process.exit(1);
  }

  console.log(`Target Environment: ${targetEnv.toUpperCase()}`);
  console.log(`Verified Host:      ${validation.host}`);
  console.log(`Connecting to:      ${sanitizeDbUrl(dbUrl)}`);

  // Configure pool with secure TLS certificate verification
  const pool = new Pool({
    connectionString: dbUrl,
    max: 5,
    ssl: {
      rejectUnauthorized: true, // Strictly enforce TLS certificate verification
    },
    connectionTimeoutMillis: 15000,
  });

  const client = await pool.connect();
  try {
    console.log('\nConnected successfully with verified TLS!');

    // 2. Apply Non-Destructive Schema DDL
    const schemaPath = path.resolve(__dirname, '../src/lib/db/schema.sql');
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Schema file not found at ${schemaPath}`);
    }
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    console.log('Step 1: Applying idempotent schema DDL (CREATE ... IF NOT EXISTS)...');
    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');
    console.log('  ✓ Schema DDL applied successfully.');

    // 3. Apply Non-Destructive Seed Data
    // Note: seed-data.sql starts with BEGIN; and ends with COMMIT;, so we do NOT double-wrap in client.query('BEGIN')
    const seedPath = path.resolve(__dirname, '../src/lib/db/seed-data.sql');
    if (!fs.existsSync(seedPath)) {
      throw new Error(`Seed data file not found at ${seedPath}. Run "npm run db:export-seed" first.`);
    }
    const seedSql = fs.readFileSync(seedPath, 'utf8');

    console.log('Step 2: Seeding 220 documents and 1,517 MiniLM 384-dim chunks...');
    await client.query(seedSql);
    console.log('  ✓ Seed data applied successfully.');

    // 4. Post-Migration Verification
    console.log('Step 3: Auditing post-migration database state...');

    const docRes = await client.query('SELECT count(*)::int AS count FROM documents');
    const chunkRes = await client.query(`
      SELECT
        count(*)::int AS total_chunks,
        count(*) FILTER (WHERE model_id = 'Xenova/all-MiniLM-L6-v2' AND dimensions = 384)::int AS minilm_chunks,
        count(DISTINCT document_id)::int AS distinct_docs
      FROM chunks
    `);
    const indexRes = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'chunks' AND indexname = 'idx_chunks_hnsw_384'
    `);

    console.log(`  - Documents in DB:     ${docRes.rows[0].count} (Expected: 220)`);
    console.log(`  - Total Chunks:        ${chunkRes.rows[0].total_chunks} (Expected: 1,517)`);
    console.log(`  - MiniLM 384 Chunks:   ${chunkRes.rows[0].minilm_chunks} (Expected: 1,517)`);
    console.log(`  - Distinct Documents:  ${chunkRes.rows[0].distinct_docs} (Expected: 220)`);
    console.log(`  - HNSW Vector Index:   ${indexRes.rows.length === 1 ? 'ACTIVE (idx_chunks_hnsw_384)' : 'MISSING'}`);

    if (
      docRes.rows[0].count === 220 &&
      chunkRes.rows[0].minilm_chunks === 1517 &&
      indexRes.rows.length === 1
    ) {
      console.log('\n✓ PRODUCTION MIGRATION & SEEDING AUDIT PASSED 100%!');
    } else {
      console.error('\n✗ MIGRATION AUDIT MISMATCH: Record counts did not match expected totals.');
      process.exit(1);
    }
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    const safeErrMsg = (err?.message || '').replace(/:([^:@\s]+)@/g, ':****@');
    console.error('Migration failed:', safeErrMsg);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runProductionMigration().catch(err => {
    const safeErrMsg = (err?.message || '').replace(/:([^:@\s]+)@/g, ':****@');
    console.error('Fatal runner error:', safeErrMsg);
    process.exit(1);
  });
}
