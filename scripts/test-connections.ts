import { Client } from 'pg';
import Redis from 'ioredis';

async function main() {
  console.log('Testing PG connection on port 5550...');
  const client = new Client({
    connectionString: 'postgresql://postgres:postgres@127.0.0.1:5550/grounded_rag'
  });
  await client.connect();
  const res = await client.query('SELECT version();');
  console.log('PG Connected! Version:', res.rows[0].version);
  
  // Check pgvector extension availability
  const ext = await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
  console.log('Vector extension verified!');
  await client.end();

  console.log('Testing Redis connection on port 6395...');
  const redis = new Redis('redis://127.0.0.1:6395');
  const pong = await redis.ping();
  console.log('Redis Ping:', pong);
  await redis.quit();
  console.log('All connections successful!');
}

main().catch(err => {
  console.error('Connection failed:', err);
  process.exit(1);
});

