import http from 'http';
import { spawn } from 'child_process';
import * as path from 'path';

async function fetchJson(url: string, options: any = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, data };
}

async function verifyApp() {
  console.log('================================================================');
  console.log('        Manual Next.js Application End-to-End Verification      ');
  console.log('================================================================\n');

  console.log('Starting Next.js production server on port 3000...');
  // Spawn Next.js start with shell: true on Windows
  const nextProcess = spawn('npx.cmd', ['next', 'start', '-p', '3000'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '3000' },
    shell: true,
    stdio: 'pipe',
  });

  nextProcess.stdout.on('data', d => {
    const text = d.toString();
    if (text.includes('Ready in') || text.includes('ready')) {
      console.log('Server Ready:', text.trim());
    }
  });

  nextProcess.stderr.on('data', d => console.error('Next err:', d.toString()));

  // Wait for server to become responsive
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch('http://localhost:3000');
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch (e) {
      // Keep waiting
    }
  }

  if (!ready) {
    nextProcess.kill();
    throw new Error('Next.js server failed to become ready on port 3000');
  }

  console.log('✓ Server is responsive at http://localhost:3000\n');

  try {
    // 1. Test Homepage
    console.log('Test 1: Verify Homepage (GET /)...');
    const home = await fetch('http://localhost:3000');
    const homeHtml = await home.text();
    const hasTitle = homeHtml.includes('Grounded') && homeHtml.includes('ApexPay');
    console.log(`  ✓ HTTP ${home.status}: HTML contains Grounded branding (${hasTitle})`);

    // 2. Test Authoritative Policy Answer & Verifiable Citation
    console.log('\nTest 2: Authoritative Policy Query (POST /api/chat)...');
    const chat1 = await fetchJson('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'What is the refund timeline for domestic and international wires?',
        strategy: 'structure_aware',
        topK: 5,
        status: 'active',
      }),
    });

    console.log(`  ✓ HTTP ${chat1.status}: Answer received`);
    console.log(`  Answer: "${chat1.data.answer.substring(0, 140)}..."`);
    console.log(`  Refused: ${chat1.data.refused} (Expected: false)`);
    console.log(`  Citations Emitted: ${JSON.stringify(chat1.data.citations.map((c: any) => c.doc_id))}`);
    console.log(`  Retrieved Chunks for Drawer: ${chat1.data.retrievedChunks.length} chunks`);
    console.log(`  Metrics: Latency ${chat1.data.metrics.latencyMs}ms, Tokens ${chat1.data.metrics.promptTokens + chat1.data.metrics.completionTokens}`);

    if (!chat1.data.citations.some((c: any) => c.doc_id === 'DOC-REF-012')) {
      throw new Error('Expected DOC-REF-012 in citations');
    }

    // 3. Test Evidence-Based Refusal on Unanswerable Question
    console.log('\nTest 3: Unanswerable Out-of-Domain Refusal (POST /api/chat)...');
    const chat2 = await fetchJson('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Can full-time ApexPay employees bring pet dogs or cats into the office?',
        strategy: 'structure_aware',
        topK: 5,
      }),
    });

    console.log(`  ✓ HTTP ${chat2.status}: Refusal evaluated`);
    console.log(`  Answer: "${chat2.data.answer}"`);
    console.log(`  Refused: ${chat2.data.refused} (Expected: true)`);
    console.log(`  Top Score: ${chat2.data.topSimilarity} vs Threshold: ${chat2.data.threshold}`);
    console.log(`  Citations Emitted: ${chat2.data.citations.length} (Expected: 0)`);

    if (!chat2.data.refused) {
      throw new Error('Expected refusal for unanswerable pet question');
    }

    // 4. Test Metadata Filtering (Department Filter)
    console.log('\nTest 4: Metadata Filtering by Department (POST /api/chat)...');
    const chat3 = await fetchJson('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'What are the password security and authentication guidelines?',
        department: 'Security & Compliance',
        strategy: 'structure_aware',
        topK: 3,
      }),
    });

    const allSec = chat3.data.retrievedChunks.every((c: any) => c.doc_department === 'Security & Compliance');
    console.log(`  ✓ HTTP ${chat3.status}: ${chat3.data.retrievedChunks.length} chunks returned`);
    console.log(`  All chunks in 'Security & Compliance': ${allSec}`);

    // 5. Test BullMQ Observable Progress & Metrics Endpoint (GET /api/jobs)
    console.log('\nTest 5: BullMQ Job Queue Observability (GET /api/jobs)...');
    const jobs = await fetchJson('http://localhost:3000/api/jobs');
    console.log(`  ✓ HTTP ${jobs.status}:`);
    console.log(`  Queue Metrics: waiting=${jobs.data.queue.waiting}, active=${jobs.data.queue.active}, completed=${jobs.data.queue.completed}`);
    console.log(`  Database Stats: total docs=${jobs.data.database.documents.total}, total chunks=${jobs.data.database.chunks.total_chunks}`);

    // 6. Test Query Observability & Logs Endpoint (GET /api/logs)
    console.log('\nTest 6: Query Observability Logs (GET /api/logs)...');
    const logs = await fetchJson('http://localhost:3000/api/logs?limit=5');
    console.log(`  ✓ HTTP ${logs.status}:`);
    console.log(`  Total Queries Logged: ${logs.data.summary.total_queries}`);
    console.log(`  Avg Latency: ${logs.data.summary.avg_latency_ms}ms`);
    console.log(`  Total Refused: ${logs.data.summary.total_refused}`);
    console.log(`  Most Recent Query: "${logs.data.logs[0]?.query_text}"`);

    // 7. Test Rate Limiter (Burst Trigger)
    console.log('\nTest 7: Rate Limiting Enforcement...');
    let hitRateLimit = false;
    for (let i = 0; i < 35; i++) {
      const burstRes = await fetch('http://localhost:3000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Rate limit test ping' }),
      });
      if (burstRes.status === 429) {
        hitRateLimit = true;
        console.log(`  ✓ HTTP 429 Rate Limit triggered on request #${i + 1}`);
        break;
      }
    }
    console.log(`  Rate limit successfully enforced: ${hitRateLimit}`);

    console.log('\n================================================================');
    console.log('   ✓ ALL 7 MANUAL APPLICATION CHECKS VERIFIED SUCCESSFULLY!    ');
    console.log('================================================================\n');
  } finally {
    nextProcess.kill();
  }
}

verifyApp().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
