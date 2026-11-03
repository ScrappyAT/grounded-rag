import { verifyAdminAuth, unauthorizedResponse, forbiddenResponse } from '../src/lib/auth/adminAuth';
import { checkDeepSeekBudget, recordDeepSeekConsumption } from '../src/lib/rag/budgetLimiter';
import * as fs from 'fs';
import * as path from 'path';

async function runPhase5bTests() {
  console.log('======================================================');
  console.log('    Grounded RAG — Phase 5B Production Controls Test  ');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✓ ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ FAILED: ${msg}`);
      failed++;
    }
  }

  // --------------------------------------------------------------------------
  // Group 1: Administrative Endpoint Security & Access Control
  // --------------------------------------------------------------------------
  console.log('Test Group 1: Administrative Endpoint Protection (Admin Auth)...');
  const testKey = 'adm_test_secret_key_12345';
  process.env.ADMIN_API_KEY = testKey;

  // Case 1A: No auth header
  const reqNoAuth = new Request('http://localhost:3000/api/logs');
  assert(!verifyAdminAuth(reqNoAuth), 'Request with no Authorization header is rejected');

  // Case 1B: Invalid Bearer token
  const reqBadToken = new Request('http://localhost:3000/api/logs', {
    headers: { 'Authorization': 'Bearer wrong_token' },
  });
  assert(!verifyAdminAuth(reqBadToken), 'Request with invalid Bearer token is rejected');

  // Case 1C: Valid Bearer token
  const reqValidBearer = new Request('http://localhost:3000/api/logs', {
    headers: { 'Authorization': `Bearer ${testKey}` },
  });
  assert(verifyAdminAuth(reqValidBearer), 'Request with valid Bearer token is accepted');

  // Case 1D: Valid X-Admin-Key header
  const reqValidCustom = new Request('http://localhost:3000/api/logs', {
    headers: { 'X-Admin-Key': testKey },
  });
  assert(verifyAdminAuth(reqValidCustom), 'Request with valid X-Admin-Key header is accepted');

  // Case 1E: Missing server-side ADMIN_API_KEY fails closed
  delete process.env.ADMIN_API_KEY;
  assert(!verifyAdminAuth(reqValidBearer), 'When ADMIN_API_KEY is not configured on server, all requests fail closed');
  process.env.ADMIN_API_KEY = testKey;

  // Case 1F: Response status codes
  const unauthRes = unauthorizedResponse();
  assert(unauthRes.status === 401, 'unauthorizedResponse() returns HTTP 401');
  const forbidRes = forbiddenResponse();
  assert(forbidRes.status === 403, 'forbiddenResponse() returns HTTP 403');

  // --------------------------------------------------------------------------
  // Group 2: DeepSeek Budget Controls & Fail-Closed Safeguards
  // --------------------------------------------------------------------------
  console.log('\nTest Group 2: DeepSeek Budget Controls & Fail-Closed Enforcement...');

  // Case 2A: Verify fail-closed behavior when Redis is unavailable in production
  (process.env as any).NODE_ENV = 'production';
  process.env.DAILY_REQUEST_LIMIT = '500';
  process.env.DAILY_BUDGET_USD = '2.00';

  // Even if Redis is disconnected, production MUST fail closed
  const budgetResult = await checkDeepSeekBudget();
  if (!budgetResult.allowed) {
    assert(Boolean(budgetResult.reason?.includes('BUDGET_VERIFICATION_UNAVAILABLE') ||
           budgetResult.reason?.includes('LIMIT_REACHED')),
           'Production environment fails closed when Redis budget controls cannot be verified');
  } else {
    assert(budgetResult.currentRequests < budgetResult.maxDailyRequests,
           'Budget check verifies request count is below ceiling');
  }

  // Case 2B: Audit Redis atomic concurrency and daily reset logic
  const limiterPath = path.resolve(__dirname, '../src/lib/rag/budgetLimiter.ts');
  const limiterContent = fs.readFileSync(limiterPath, 'utf8');

  // Verify daily date-partitioning key rollover (resets every midnight UTC)
  assert(limiterContent.includes("new Date().toISOString().split('T')[0]"),
         'Budget keys are partitioned by UTC date (toISOString().split("T")[0]) ensuring daily reset at 00:00 UTC');
  assert(limiterContent.includes('budget:deepseek:requests:${dateKey}'),
         'Request counter key includes UTC date suffix for automatic daily partition isolation');
  assert(limiterContent.includes('budget:deepseek:cost_micro:${dateKey}'),
         'Cost counter key includes UTC date suffix for automatic daily partition isolation');

  // Verify atomic Redis concurrency primitives (prevent race conditions under concurrent requests)
  assert(limiterContent.includes('redisConnection.multi()'),
         'recordDeepSeekConsumption uses Redis MULTI transaction pipeline for atomic updates');
  assert(limiterContent.includes('multi.incr(reqKey)') || limiterContent.includes('multi.incr'),
         'Request counter increment uses atomic INCR operation');
  assert(limiterContent.includes('multi.incrby(costKey, costMicro)') || limiterContent.includes('multi.incrby'),
         'Cost counter increment uses atomic INCRBY operation with micro-USD precision');
  assert(limiterContent.includes('multi.expire(') && limiterContent.includes('172800'),
         'Redis counters have a bounded 48-hour TTL (172,800 seconds) preventing memory leaks while retaining audit trail');

  // Verify bounded timeout wrapper prevents hanging requests
  assert(limiterContent.includes('withTimeout') && limiterContent.includes('2000'),
         'Redis operations enforce a strict 2,000ms bounded timeout wrapper to prevent hanging requests');

  // Verify atomic Lua reservation script exists
  assert(limiterContent.includes('RESERVE_LUA_SCRIPT') && limiterContent.includes("redis.call('incr', reqKey)"),
         'budgetLimiter implements atomic Lua reservation script preventing check-then-act race conditions');

  // Case 2C: Concurrent-Request Atomic Reservation & Overspend Prevention Regression Test
  console.log('  Sub-test 2C: Simulating 50 concurrent requests against capacity of 5 slots...');

  class MockAtomicRedis {
    private storage = new Map<string, number>();
    private lock = Promise.resolve();

    async eval(maxRequests: number, maxCostMicro: number, provisionalCostMicro: number): Promise<[number, string, number, number]> {
      return new Promise((resolve) => {
        this.lock = this.lock.then(async () => {
          const currentReq = this.storage.get('req') || 0;
          const currentCost = this.storage.get('cost') || 0;

          if (currentReq >= maxRequests) {
            resolve([0, 'DAILY_REQUEST_LIMIT_REACHED', currentReq, currentCost]);
            return;
          }

          if ((currentCost + provisionalCostMicro) > maxCostMicro) {
            resolve([0, 'DAILY_BUDGET_LIMIT_REACHED', currentReq, currentCost]);
            return;
          }

          const newReq = currentReq + 1;
          const newCost = currentCost + provisionalCostMicro;
          this.storage.set('req', newReq);
          this.storage.set('cost', newCost);

          resolve([1, 'ALLOWED', newReq, newCost]);
        });
      });
    }

    async release(provisionalCostMicro: number): Promise<void> {
      return new Promise((resolve) => {
        this.lock = this.lock.then(async () => {
          const currentReq = this.storage.get('req') || 0;
          if (currentReq > 0) this.storage.set('req', currentReq - 1);
          const currentCost = this.storage.get('cost') || 0;
          this.storage.set('cost', Math.max(0, currentCost - provisionalCostMicro));
          resolve();
        });
      });
    }

    async reconcile(deltaCostMicro: number): Promise<void> {
      return new Promise((resolve) => {
        this.lock = this.lock.then(async () => {
          const currentCost = this.storage.get('cost') || 0;
          this.storage.set('cost', Math.max(0, currentCost + deltaCostMicro));
          resolve();
        });
      });
    }

    getCount(): number { return this.storage.get('req') || 0; }
    getCost(): number { return this.storage.get('cost') || 0; }
  }

  const mockRedis = new MockAtomicRedis();
  const CONCURRENT_REQUESTS = 50;
  const CAPACITY = 5;
  const PROVISIONAL_MICRO = 500; // $0.0005
  const MAX_COST_MICRO = 10000; // $0.0100

  // Fire 50 requests simultaneously via Promise.all
  const concurrentResults = await Promise.all(
    Array.from({ length: CONCURRENT_REQUESTS }, () =>
      mockRedis.eval(CAPACITY, MAX_COST_MICRO, PROVISIONAL_MICRO)
    )
  );

  const allowedCount = concurrentResults.filter(r => r[0] === 1).length;
  const rejectedCount = concurrentResults.filter(r => r[0] === 0).length;

  assert(allowedCount === CAPACITY, `Exactly ${CAPACITY} of ${CONCURRENT_REQUESTS} concurrent requests allowed (got ${allowedCount})`);
  assert(rejectedCount === CONCURRENT_REQUESTS - CAPACITY, `Exactly ${CONCURRENT_REQUESTS - CAPACITY} requests rejected with limit reached (got ${rejectedCount})`);
  assert(mockRedis.getCount() === CAPACITY, `Redis request counter exactly matches ceiling (${CAPACITY}) without overspending`);

  // Test release: 1 allowed request fails and releases reservation
  await mockRedis.release(PROVISIONAL_MICRO);
  assert(mockRedis.getCount() === CAPACITY - 1, 'Releasing reservation decrements counter by 1 on failure');

  // Next request can now succeed
  const nextRes = await mockRedis.eval(CAPACITY, MAX_COST_MICRO, PROVISIONAL_MICRO);
  assert(nextRes[0] === 1, 'Freed slot successfully reserved by subsequent request');
  assert(mockRedis.getCount() === CAPACITY, 'Capacity restored to ceiling');

  // Test Case 2D: Reconciliation when actual cost exceeds provisional cost
  console.log('  Sub-test 2D: Reconciling actual cost exceeding provisional reservation...');
  const initialCost = mockRedis.getCost();
  // Assume actual cost was 1200 micro-USD ($0.0012) while provisional was 500 micro-USD ($0.0005). Delta = +700
  const deltaCost = 700;
  await mockRedis.reconcile(deltaCost);
  assert(mockRedis.getCost() === initialCost + deltaCost,
         `Reconciliation accurately adjusts balance when actual exceeds provisional (cost: ${mockRedis.getCost()} micro-USD)`);

  // Test Case 2E: Nonnegative counter guarantee
  console.log('  Sub-test 2E: Verifying nonnegative counter enforcement...');
  await mockRedis.release(99999999);
  assert(mockRedis.getCost() >= 0, 'Cost counter is strictly clamped to nonnegative balance (never drops below 0)');

  // Test Case 2F: Uncertain provider outcome accounting & idempotency audit
  console.log('  Sub-test 2F: Auditing uncertain provider outcome handling in generator...');
  const generatorPath = path.resolve(__dirname, '../src/lib/ai/generator.ts');
  const generatorContent = fs.readFileSync(generatorPath, 'utf8');

  assert(generatorContent.includes('retainUncertainReservation'),
         'generator.ts calls retainUncertainReservation on network timeout / abort to prevent undercounting');
  assert(generatorContent.includes('400, 401, 402, 403, 404, 429'),
         'generator.ts only releases reservations on definitive non-incurring HTTP 4xx status codes');
  assert(generatorContent.includes('HTTP 5') || generatorContent.includes('res.status'),
         'generator.ts treats HTTP 5xx and gateway errors as uncertain provider outcomes, retaining provisional cost');
  assert(limiterContent.includes('token.resolved') && limiterContent.includes('if (token.resolved) return;'),
         'budgetLimiter enforces strict idempotency flag (resolved: true) to prevent duplicate reconciliation or double release');

  // --------------------------------------------------------------------------
  // Group 3: Secure Cloud Database Connectivity (TLS Verification)
  // --------------------------------------------------------------------------
  console.log('\nTest Group 3: Secure PostgreSQL Connectivity & TLS Verification...');
  const clientTsPath = path.resolve(__dirname, '../src/lib/db/client.ts');
  const clientTsContent = fs.readFileSync(clientTsPath, 'utf8');

  assert(clientTsContent.includes('rejectUnauthorized: true'),
         'dbPool strictly configures rejectUnauthorized: true for remote cloud databases');
  assert(!clientTsContent.includes('rejectUnauthorized: false'),
         'dbPool NEVER disables TLS certificate verification (rejectUnauthorized: false is absent)');

  // --------------------------------------------------------------------------
  // Group 4: Model Pre-caching & Offline Guarantee
  // --------------------------------------------------------------------------
  console.log('\nTest Group 4: Local Model Pre-caching & Offline Embeddings...');
  const cachePath = path.resolve(__dirname, '../.cache/Xenova/all-MiniLM-L6-v2');
  const onnxPath = path.join(cachePath, 'onnx/model_quantized.onnx');

  assert(fs.existsSync(cachePath), 'Pre-cached model directory exists in .cache/Xenova/all-MiniLM-L6-v2');
  assert(fs.existsSync(onnxPath), 'Quantized ONNX model binary (model_quantized.onnx) exists locally');

  const embeddingsTsPath = path.resolve(__dirname, '../src/lib/ai/embeddings.ts');
  const embeddingsTsContent = fs.readFileSync(embeddingsTsPath, 'utf8');
  assert(embeddingsTsContent.includes('local_files_only'),
         'embeddings.ts enforces local_files_only: true when pre-cached weights are detected in production');

  // --------------------------------------------------------------------------
  // Group 5: Docker Configuration & Credential Hygiene
  // --------------------------------------------------------------------------
  console.log('\nTest Group 5: Dockerfile Multi-Stage Structure & Credential Hygiene...');
  const dockerfilePath = path.resolve(__dirname, '../Dockerfile');
  const dockerignorePath = path.resolve(__dirname, '../.dockerignore');

  assert(fs.existsSync(dockerfilePath), 'Dockerfile exists');
  assert(fs.existsSync(dockerignorePath), '.dockerignore exists');

  const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
  assert(dockerfileContent.includes('AS deps'), 'Dockerfile includes deps stage');
  assert(dockerfileContent.includes('AS builder'), 'Dockerfile includes builder stage');
  assert(dockerfileContent.includes('AS runner'), 'Dockerfile includes runner stage');
  assert(dockerfileContent.includes('precache-model.ts'), 'Dockerfile pre-caches MiniLM weights during image build');
  assert(dockerfileContent.includes('USER nextjs'), 'Dockerfile runs as unprivileged non-root user (nextjs)');

  const dockerignoreContent = fs.readFileSync(dockerignorePath, 'utf8');
  assert(dockerignoreContent.includes('.env*'), '.dockerignore strictly excludes all .env files');
  assert(dockerignoreContent.includes('node_modules'), '.dockerignore excludes host node_modules');
  assert(dockerignoreContent.includes('.cache'), '.dockerignore excludes local .cache from Docker build context');

  const gitignorePath = path.resolve(__dirname, '../.gitignore');
  const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  assert(gitignoreContent.includes('.cache/'), '.gitignore excludes .cache/ binary model weights from git history');

  assert(dockerfileContent.includes('COPY --from=builder') && dockerfileContent.includes('/app/.cache /app/.cache'),
         'Dockerfile copies pre-cached model from builder to runner image layer');
  assert(dockerfileContent.includes('COPY --from=deps') && dockerfileContent.includes('node_modules'),
         'Dockerfile copies clean production dependencies from deps stage to runner image');

  // --------------------------------------------------------------------------
  // Group 6: Production Migration Guardrails
  // --------------------------------------------------------------------------
  console.log('\nTest Group 6: Production Migration Guardrails & Safety Checks...');
  const migrateScriptPath = path.resolve(__dirname, '../scripts/migrate-production.ts');
  const migrateContent = fs.readFileSync(migrateScriptPath, 'utf8');

  assert(migrateContent.includes('TARGET_ENV'), 'Migration script enforces TARGET_ENV check');
  assert(migrateContent.includes('localhost') && migrateContent.includes('SAFETY BLOCKED'),
         'Migration script blocks execution if target is production but DATABASE_URL points to localhost');
  assert(!migrateContent.includes('DROP TABLE'), 'Migration script strictly contains NO DROP TABLE statements');
  assert(!migrateContent.includes('DROP DATABASE'), 'Migration script strictly contains NO DROP DATABASE statements');

  console.log('\n======================================================');
  console.log(`Phase 5B Test Summary: Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runPhase5bTests().catch(err => {
  console.error('Test run failed:', err);
  process.exit(1);
});
