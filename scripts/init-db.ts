import * as fs from 'fs';
import * as path from 'path';
import { dbPool } from '../src/lib/db/client';

export async function initDb() {
  console.log('Initializing Grounded PostgreSQL database & pgvector schema...');
  const schemaPath = path.resolve(__dirname, '..', 'src', 'lib', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log('Schema applied successfully!');

    // Verify HNSW indices
    const res = await client.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'chunks' AND indexname IN ('idx_chunks_hnsw_384', 'idx_chunks_hnsw_768');
    `);

    console.log(`Verified ${res.rows.length} HNSW Vector Indices:`);
    for (const r of res.rows) {
      console.log(` - ${r.indexname}: ${r.indexdef}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to initialize database schema:', err);
    throw err;
  } finally {
    client.release();
    await dbPool.end();
  }
}

if (require.main === module) {
  initDb().catch(err => {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  });
}

