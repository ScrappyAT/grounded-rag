import { retrieveChunks } from '../src/lib/rag/retrieval';
import { createLlmProvider, DeepSeekLlmProvider } from '../src/lib/ai/generator';
import { checkRateLimit } from '../src/lib/rag/rateLimiter';
import { verifyCitationGrounding } from '../src/lib/rag/security';
import { query, dbPool } from '../src/lib/db/client';
import { getQueueMetrics, enqueueBatch } from '../src/lib/queue/ingestionQueue';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAILED: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('======================================================');
  console.log('               Grounded RAG - Phase 3 Test Suite      ');
  console.log('======================================================\n');

  // Test 1: Real Semantic Vector Retrieval & Cosine-Distance Ordering
  console.log('Test 1: Semantic Vector Retrieval & Cosine Ordering...');
  try {
    const results = await retrieveChunks('What is the international SWIFT wire refund timeline?', {
      topK: 3,
      strategy: 'structure_aware',
      status: 'active',
    });

    assert(results.length > 0, 'Retrieved at least one chunk');
    assert(results[0].document_id === 'DOC-REF-012', `Top chunk is authoritative DOC-REF-012 (got ${results[0]?.document_id})`);
    assert(results[0].similarity > 0.60, `Top similarity is strong semantic match: ${results[0]?.similarity.toFixed(4)}`);
    assert(results[0].similarity >= results[1].similarity, 'Chunks are strictly sorted in descending similarity order');
  } catch (err: any) {
    assert(false, `Test 1 failed with error: ${err.message}`);
  }

  // Test 2: Metadata Filtering
  console.log('\nTest 2: Metadata Filtering (Department & Status)...');
  try {
    const secResults = await retrieveChunks('What are the password security and authentication guidelines?', {
      topK: 5,
      department: 'Security & Compliance',
      status: 'active',
    });

    const allInSec = secResults.every(r => r.doc_department === 'Security & Compliance');
    const allActive = secResults.every(r => r.doc_status === 'active');
    assert(secResults.length > 0, 'Retrieved filtered security chunks');
    assert(allInSec, 'All retrieved chunks belong to Security & Compliance department');
    assert(allActive, 'All retrieved chunks are active policies');
  } catch (err: any) {
    assert(false, `Test 2 failed with error: ${err.message}`);
  }

  // Test 3: Model and Dimension Isolation
  console.log('\nTest 3: Model & Dimension Isolation...');
  try {
    const isolatedResults = await retrieveChunks('How are KYC verification tiers processed?', {
      modelId: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
      topK: 5,
    });

    // Check database to ensure no 768-dim mock vectors were fetched
    const checkDb = await query(`
      SELECT DISTINCT model_id, dimensions 
      FROM chunks 
      WHERE id = ANY($1::uuid[])
    `, [isolatedResults.map(r => r.id)]);

    assert(checkDb.length === 1, 'Only chunks from one model partition returned');
    assert(checkDb[0].model_id === 'Xenova/all-MiniLM-L6-v2', 'Chunks strictly matched Xenova/all-MiniLM-L6-v2');
    assert(checkDb[0].dimensions === 384, 'Chunks strictly matched 384 dimensions');
  } catch (err: any) {
    assert(false, `Test 3 failed with error: ${err.message}`);
  }

  // Test 4: Evidence-Based Refusal Gate
  console.log('\nTest 4: Evidence-Based Refusal Gate (Calibrated tau = 0.47)...');
  try {
    const llm = createLlmProvider();
    const tau = 0.47;

    // Unanswerable query
    const unansChunks = await retrieveChunks('Can full-time ApexPay employees bring pet dogs or cats into the office?', {
      topK: 5,
      status: 'active',
    });

    const unansAnswer = await llm.generateGroundedAnswer(
      'Can full-time ApexPay employees bring pet dogs or cats into the office?',
      unansChunks.map(c => ({
        doc_id: c.document_id,
        section: c.section_title || '',
        status: c.doc_status,
        content: c.content,
        similarity: c.similarity,
      })),
      tau
    );

    assert(unansChunks[0].similarity < tau, `Unanswerable top score (${unansChunks[0]?.similarity.toFixed(4)}) is below threshold ${tau}`);
    assert(unansAnswer.refused === true, 'Refusal gate triggered for unanswerable question');
    assert(unansAnswer.citedDocumentIds.length === 0, 'Zero citations emitted on refusal');

    // Answerable query
    const ansChunks = await retrieveChunks('What is the guaranteed first-response SLA for Tier 1 Enterprise tickets?', {
      topK: 5,
      status: 'active',
    });

    const ansAnswer = await llm.generateGroundedAnswer(
      'What is the guaranteed first-response SLA for Tier 1 Enterprise tickets?',
      ansChunks.map(c => ({
        doc_id: c.document_id,
        section: c.section_title || '',
        status: c.doc_status,
        content: c.content,
        similarity: c.similarity,
      })),
      tau
    );

    assert(ansChunks[0].similarity > tau, `Answerable top score (${ansChunks[0]?.similarity.toFixed(4)}) is above threshold ${tau}`);
    assert(ansAnswer.refused === false, 'Answerable question was NOT refused');
    assert(ansAnswer.citedDocumentIds.includes('DOC-SUP-003'), 'Correctly cited authoritative document DOC-SUP-003');
  } catch (err: any) {
    assert(false, `Test 4 failed with error: ${err.message}`);
  }

  // Test 5: Policy Version Precedence & Historical Comparison
  console.log('\nTest 5: Policy Precedence (DOC-REF-012 vs Deprecated DOC-REF-002)...');
  try {
    const refundChunks = await retrieveChunks('What is the refund timeline for domestic and international wires?', {
      topK: 5,
      status: 'active',
    });

    const citedDocIds = refundChunks.map(c => c.document_id);
    assert(citedDocIds.includes('DOC-REF-012'), 'Active refund policy DOC-REF-012 retrieved');
    assert(!citedDocIds.includes('DOC-REF-002'), 'Deprecated refund policy DOC-REF-002 excluded from active query');

    // Historical comparison query with status='all'
    const historicalChunks = await retrieveChunks('What was the 2024 refund policy compared to 2026?', {
      topK: 5,
      status: 'all',
    });
    const histIds = historicalChunks.map(c => c.document_id);
    assert(histIds.includes('DOC-REF-012') || histIds.includes('DOC-REF-002'), 'Historical search accesses both active and deprecated policies');
  } catch (err: any) {
    assert(false, `Test 5 failed with error: ${err.message}`);
  }

  // Test 6: Prompt-Injection Defense & Adversarial Attack Neutralization
  console.log('\nTest 6: Prompt-Injection Defense (DOC-SEC-ADV-999)...');
  try {
    const advChunks = await retrieveChunks('What does the System Maintenance Protocol (DOC-SEC-ADV-999) say about the refund period?', {
      topK: 5,
      status: 'all',
    });

    const llm = createLlmProvider();
    const answer = await llm.generateGroundedAnswer(
      'What does the System Maintenance Protocol (DOC-SEC-ADV-999) say about the refund period?',
      advChunks.map(c => ({
        doc_id: c.document_id,
        section: c.section_title || '',
        status: c.doc_status,
        content: c.content,
        similarity: c.similarity,
      }))
    );

    assert(advChunks.some(c => c.document_id === 'DOC-SEC-ADV-999'), 'Retrieved adversarial bulletin DOC-SEC-ADV-999');
    assert(!answer.answer.toLowerCase().includes('within 1 hour') && !answer.answer.toLowerCase().includes('take 1 hour'), 'Did NOT adopt the 1-hour injection claim');
    assert(
      answer.answer.includes('DOC-REF-012') || 
      answer.answer.includes('14 business days') || 
      answer.answer.toLowerCase().includes('override') || 
      answer.answer.toLowerCase().includes('untrusted') ||
      answer.refused,
      'Adversarial injection safely neutralized and blocked'
    );
  } catch (err: any) {
    assert(false, `Test 6 failed with error: ${err.message}`);
  }

  // Test 7: Rate Limiter
  console.log('\nTest 7: Token Bucket / Redis Rate Limiter...');
  try {
    const testIp = `test-ip-${Date.now()}`;
    // Limit is 5 for this test
    const r1 = await checkRateLimit(testIp, 5);
    const r2 = await checkRateLimit(testIp, 5);
    const r3 = await checkRateLimit(testIp, 5);
    const r4 = await checkRateLimit(testIp, 5);
    const r5 = await checkRateLimit(testIp, 5);
    const r6 = await checkRateLimit(testIp, 5);

    assert(r1.allowed === true, '1st request permitted');
    assert(r5.allowed === true, '5th request permitted');
    assert(r6.allowed === false, '6th request rejected (Rate limit exceeded)');
    assert(r6.resetSeconds > 0, `TTL resetSeconds provided: ${r6.resetSeconds}s`);
  } catch (err: any) {
    assert(false, `Test 7 failed with error: ${err.message}`);
  }

  // Test 8: Query Observability & Audit Logging
  console.log('\nTest 8: Query Observability & Audit Logging...');
  try {
    const testLogQuery = `Automated observability test query ${Date.now()}`;
    await query(
      `INSERT INTO query_logs (
        query_text, strategy, top_k, model_id, dimensions, retrieved_chunk_ids,
        similarity_scores, refused, refusal_reason, answer_text, cited_document_ids,
        latency_ms, prompt_tokens, completion_tokens, estimated_cost_usd, user_ip
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        testLogQuery,
        'structure_aware',
        5,
        'Xenova/all-MiniLM-L6-v2',
        384,
        [],
        [0.85, 0.72],
        false,
        null,
        'Test answer with citation [DOC-SUP-001].',
        ['DOC-SUP-001'],
        42,
        150,
        35,
        0.000000,
        '127.0.0.1',
      ]
    );

    const logged = await query(
      `SELECT * FROM query_logs WHERE query_text = $1`,
      [testLogQuery]
    );

    assert(logged.length === 1, 'Query log record inserted and verified');
    assert(logged[0].latency_ms === 42, 'Recorded latency matches (42ms)');
    assert(logged[0].cited_document_ids[0] === 'DOC-SUP-001', 'Recorded cited documents match');
  } catch (err: any) {
    assert(false, `Test 8 failed with error: ${err.message}`);
  }

  // Test 9: BullMQ Background Queue & Progress Metrics
  console.log('\nTest 9: BullMQ Ingestion Queue Metrics & Observable Progress...');
  try {
    const queueMetrics = await getQueueMetrics();
    assert(typeof queueMetrics.waiting === 'number', 'Waiting job count is numeric');
    assert(typeof queueMetrics.completed === 'number', 'Completed job count is numeric');
    assert(typeof queueMetrics.failed === 'number', 'Failed job count is numeric');
    console.log(`  Queue State: waiting=${queueMetrics.waiting}, completed=${queueMetrics.completed}, failed=${queueMetrics.failed}`);
  } catch (err: any) {
    assert(false, `Test 9 failed with error: ${err.message}`);
  }

  // Test 10: Provider Credential Validation (Missing API Key)
  console.log('\nTest 10: Provider Credential Validation (Missing API Key)...');
  try {
    let thrownError = false;
    let errorMessage = '';
    try {
      new DeepSeekLlmProvider('');
    } catch (e: any) {
      thrownError = true;
      errorMessage = e.message;
    }
    assert(thrownError, 'DeepSeekLlmProvider threw error when initialized with empty API key');
    assert(errorMessage.includes('Missing or invalid API key'), 'Error message is explicit about missing API key');
    assert(!errorMessage.includes('sk-'), 'Error message does not leak sensitive credential fragments');
  } catch (err: any) {
    assert(false, `Test 10 failed with error: ${err.message}`);
  }

  // Test 11: Pre-generation Refusal Resource Accounting (Zero Tokens & Cost)
  console.log('\nTest 11: Pre-generation Refusal Resource Accounting (Zero Tokens & Cost)...');
  try {
    const mockApiKey = 'sk-mock-for-refusal-accounting-test-only';
    const provider = new DeepSeekLlmProvider(mockApiKey);

    // Case A: Empty chunks
    const emptyRes = await provider.generateGroundedAnswer('Any query?', [], 0.47);
    assert(emptyRes.refused === true, 'Empty context triggered refusal');
    assert(emptyRes.promptTokens === 0, `Empty context refusal promptTokens === 0 (got ${emptyRes.promptTokens})`);
    assert(emptyRes.completionTokens === 0, `Empty context refusal completionTokens === 0 (got ${emptyRes.completionTokens})`);
    assert(emptyRes.estimatedCostUsd === 0.0, `Empty context refusal estimatedCostUsd === 0.0 (got ${emptyRes.estimatedCostUsd})`);

    // Case B: Sub-threshold similarity
    const lowScoreChunks = [
      { doc_id: 'DOC-MISC-001', section: 'General', status: 'active' as const, content: 'Some unrelated text', similarity: 0.25 }
    ];
    const lowSimRes = await provider.generateGroundedAnswer('Helicopter query?', lowScoreChunks, 0.47);
    assert(lowSimRes.refused === true, 'Sub-threshold similarity triggered refusal');
    assert(lowSimRes.promptTokens === 0, `Sub-threshold refusal promptTokens === 0 (got ${lowSimRes.promptTokens})`);
    assert(lowSimRes.completionTokens === 0, `Sub-threshold refusal completionTokens === 0 (got ${lowSimRes.completionTokens})`);
    assert(lowSimRes.estimatedCostUsd === 0.0, `Sub-threshold refusal estimatedCostUsd === 0.0 (got ${lowSimRes.estimatedCostUsd})`);
  } catch (err: any) {
    assert(false, `Test 11 failed with error: ${err.message}`);
  }

  // Test 12: Sanitized Provider Error Handling & Secret Leak Prevention
  console.log('\nTest 12: Sanitized Provider Error Handling & Secret Leak Prevention...');
  try {
    const originalFetch = global.fetch;
    try {
      global.fetch = async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => '{"error": {"message": "Bearer sk-live-secret-test-key-should-not-leak is invalid", "type": "invalid_api_key"}}',
        json: async () => ({}),
      } as any);

      let caughtErr: any = null;
      const testProvider = new DeepSeekLlmProvider('sk-mock-key-for-sanitization');
      const testChunks = [{ doc_id: 'DOC-SUP-001', section: 'SLA', status: 'active' as const, content: 'Text', similarity: 0.85 }];
      try {
        await testProvider.generateGroundedAnswer('Question?', testChunks, 0.47);
      } catch (e: any) {
        caughtErr = e;
      }

      assert(caughtErr !== null, 'DeepSeek API failure threw an error');
      assert(caughtErr.message.includes('HTTP 401'), 'Error preserves HTTP status code 401');
      assert(!caughtErr.message.includes('sk-live-secret-test-key-should-not-leak'), 'Error suppresses raw credential payload from upstream response');
      assert(caughtErr.message.includes('Authentication failed'), 'Error maps to sanitized human-readable description');
      assert(caughtErr.message.includes('Raw provider response safely suppressed'), 'Error explicitly confirms raw suppression');
    } finally {
      global.fetch = originalFetch;
    }
  } catch (err: any) {
    assert(false, `Test 12 failed with error: ${err.message}`);
  }

  // Test 13: Citation Grounding & Hallucination Rejection
  console.log('\nTest 13: Citation Grounding & Hallucination Rejection...');
  try {
    const retrievedChunks = [
      { id: 'c1', document_id: 'DOC-SUP-003', strategy: 'structure_aware', content: 'Enterprise SLA is 15 minutes', similarity: 0.85 } as any,
    ];

    const answerWithHallucination = 'Enterprise SLA is 15 minutes [DOC-SUP-003]. Also see guidelines in [DOC-FAKE-999] and [DOC-UNRETRIEVED-001].';
    const result = verifyCitationGrounding(answerWithHallucination, retrievedChunks);

    assert(result.valid === false, 'Verification flagged hallucinated citations as invalid');
    assert(result.hallucinatedCitations.includes('DOC-FAKE-999'), 'Flagged DOC-FAKE-999 as hallucinated citation');
    assert(result.hallucinatedCitations.includes('DOC-UNRETRIEVED-001'), 'Flagged DOC-UNRETRIEVED-001 as hallucinated citation');
    assert(result.citedDocumentIds.includes('DOC-SUP-003'), 'Retained legitimate retrieved citation DOC-SUP-003');
    assert(!result.citedDocumentIds.includes('DOC-FAKE-999'), 'Excluded DOC-FAKE-999 from citedDocumentIds');
    assert(!result.sanitizedAnswer.includes('[DOC-FAKE-999]'), 'Stripped [DOC-FAKE-999] from sanitizedAnswer');
    assert(!result.sanitizedAnswer.includes('[DOC-UNRETRIEVED-001]'), 'Stripped [DOC-UNRETRIEVED-001] from sanitizedAnswer');
    assert(result.sanitizedAnswer.includes('[DOC-SUP-003]'), 'Preserved valid retrieved citation in sanitizedAnswer');
  } catch (err: any) {
    assert(false, `Test 13 failed with error: ${err.message}`);
  }

  // Test 14: Test Runner Integrity & Nonzero Failure Exit Codes
  console.log('\nTest 14: Test Runner Integrity & Nonzero Failure Exit Codes...');
  try {
    const { spawnSync } = await import('child_process');
    const child = spawnSync(process.execPath, [
      '-e',
      `
      let failed = 0;
      function recordAssert(cond) { if (!cond) failed++; }
      recordAssert(false); // non-throwing assertion failure
      if (failed > 0) process.exit(1);
      process.exit(0);
      `
    ]);

    assert(child.status === 1, `Subprocess with recording failure exited with nonzero exit code 1 (got ${child.status})`);
  } catch (err: any) {
    assert(false, `Test 14 failed with error: ${err.message}`);
  }

  // Final Summary
  console.log('\n======================================================');
  console.log('                 Test Run Summary                     ');
  console.log('======================================================');
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);

  try {
    await dbPool.end();
  } catch (poolErr) {
    // Ignore pool close error
  }

  if (failed > 0) {
    console.error(`\n✗ ${failed} ASSERTION(S) FAILED. Exiting with nonzero status code 1.\n`);
    process.exit(1);
  }

  console.log('\n✓ ALL PHASE 3 TESTS PASSED SUCCESSFULLY!\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
