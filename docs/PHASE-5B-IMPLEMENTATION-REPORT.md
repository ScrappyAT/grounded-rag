# Grounded RAG — Phase 5B: Deployment Implementation Preparation Report

**Date:** November 3, 2026
**Git Branch:** `feat/grounded-production-deployment` (branched from `main` at `d75243a`)
**Project:** Grounded — Enterprise RAG Document Intelligence Assistant (`c:\Users\HP\Desktop\grounded-rag`)
**Status:** PR #2 Code Review Corrections Completed & Verified (No cloud services provisioned; No cloud migrations executed)

---

## Executive Summary

Phase 5B transitions Grounded from a local multi-process development environment into a self-contained, budget-conscious production deployment architecture designed for bootcamp graduation and public demonstration.

Following thorough code review on PR #2, all required corrections have been implemented and validated:
1. **Redis Budget Reservations & Atomic Idempotency (`src/lib/rag/budgetLimiter.ts`):**
   - Implemented Redis-side reservation status key (`budget:deepseek:reservation:${dateKey}:${reservationId}`) with explicit states (`RESERVED`, `COMMITTED`, `RELEASED`, `RETAINED`).
   - Tokens are **never** marked resolved before Redis confirms settlement, permitting retries upon network failures.
   - Stored original reservation `dateKey` on `ReservationToken` to ensure settlement is strictly attributed to the original UTC date partition across midnight UTC boundaries.
   - Clamped counters to guarantee nonnegative balances and documented limits requiring provider-side console controls.
   - Preserved fail-closed enforcement when Redis is unreachable in production.
2. **Public API Error Security & IP Privacy (`src/app/api/chat/route.ts` & others):**
   - Eliminated exposure of raw `err.message` across all public API routes (`/api/chat`, `/api/logs`, `/api/ingest`, `/api/jobs`).
   - Standardized generic public error messages (`HTTP 500`) while preserving sanitized server-side diagnostics with API key and credential redaction.
   - Implemented `maskIp` in `src/lib/rag/security.ts` to mask the last octet of IPv4 and host bits of IPv6, ensuring raw user IPs are never written to `query_logs`.
3. **Production Migration Guardrails & Host Safety (`scripts/migrate-production.ts`):**
   - Added strict target host validation requiring verified Neon endpoints (`*.neon.tech`), rejecting localhost, `127.0.0.1`, and unexpected cloud providers.
   - Redacted database passwords from connection string logs and error messages.
   - Fixed transaction handling: removed redundant outer `BEGIN`/`COMMIT` wrapper around `seed-data.sql` (which already contains its own `BEGIN;` and `COMMIT;`).
4. **Strict Offline MiniLM Model Verification (`src/lib/ai/embeddings.ts` & `Dockerfile`):**
   - Implemented `auditModelArtifacts` requiring all 4 essential files (`config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_quantized.onnx`).
   - Enforced `local_files_only: true` unconditionally in production, throwing an explicit `Strict Offline Guarantee` error if incomplete rather than silently downloading weights.
   - Added `--chown=nextjs:nodejs` to all runner layers in `Dockerfile` ensuring non-root privilege separation.

---

## 1. Git Status & Changed Files

### Current Branch
`feat/grounded-production-deployment`

### Modified Files (Existing Codebase)
- `src/lib/rag/budgetLimiter.ts`: Redis-side reservation status keys, midnight UTC rollover handling, un-resolved on network error, documented overage limits.
- `src/app/api/chat/route.ts`: Sanitized generic errors, masked user IP before database insertion, redacted server logs.
- `src/app/api/logs/route.ts`: Generic error response, redacted server logs, user IP masking.
- `src/app/api/ingest/route.ts`: Generic error response, `READ_ONLY_MODE` enforcement, admin auth.
- `src/app/api/jobs/route.ts`: Generic error response, admin auth.
- `src/lib/rag/security.ts`: Added `maskIp` IP anonymization helper.
- `src/lib/ai/embeddings.ts`: Added `auditModelArtifacts`, strict offline model verification, guaranteed no runtime downloads in production.
- `scripts/precache-model.ts`: Post-cache verification of all 4 required artifacts.
- `scripts/migrate-production.ts`: Strict Neon host validation, password redaction, clean single-transaction seeding.
- `scripts/test-phase5b-controls.ts`: Expanded to 52 automated assertions covering all PR #2 requirements.
- `Dockerfile`: Added `--chown=nextjs:nodejs` on all runner layers (`node_modules`, `.cache`, `package.json`, `.next`, `public`).
- `src/lib/db/client.ts`: Configured `ssl: { rejectUnauthorized: true }` for cloud databases.
- `.env.example`: Updated with DeepSeek configuration, production flags, and budget guardrails.
- `README.md`: Updated with Phase 5 target architecture, Docker commands, and migration procedures.

### Untracked Deliverables
- `.dockerignore`: Exclusion rules for secrets, local node_modules, git, and build caches.
- `docs/PHASE-5-DEPLOYMENT-PLAN.md`: Phase 5A architectural evaluation and deployment strategy.
- `docs/PHASE-5B-IMPLEMENTATION-REPORT.md`: This comprehensive verification report.
- `src/lib/auth/adminAuth.ts`: Standardized administrative bearer authentication helper.
- `src/lib/db/seed-data.sql`: Standalone 14.36 MB SQL transaction containing 220 documents, 1,517 chunks, and 1,185 embedding cache entries.
- `src/lib/db/seed-manifest.json`: Metadata manifest tracking corpus distribution and chunk counts.

---

## 2. Multi-Stage Dockerfile & Packaging

### Container Architecture
The production Dockerfile is structured across 3 isolated build stages using `node:20-slim` (Debian Bookworm) to ensure full compatibility with the native C++ ONNX runtime (`onnxruntime-node`):

1. **`deps` Stage:**
   - Installs system build dependencies (`openssl`, `ca-certificates`).
   - Copies `package.json` and `package-lock.json`.
   - Runs `npm ci --omit=dev` for clean production dependency installation.
2. **`builder` Stage:**
   - Runs full `npm ci` including build tooling.
   - Copies source code and pre-caches the `all-MiniLM-L6-v2` ONNX model into `/app/.cache/Xenova/all-MiniLM-L6-v2`.
   - Verifies all 4 required ONNX artifacts exist locally before building.
   - Runs `npm run build` using Next.js production bundler.
3. **`runner` Stage (Minimal Production Image):**
   - Creates an unprivileged system user and group: `nextjs:nodejs` (`UID 1001`).
   - Copies `.cache` pre-cached weights with `--chown=nextjs:nodejs`.
   - Copies `node_modules` with `--chown=nextjs:nodejs`.
   - Copies `.next` build output and `public` with `--chown=nextjs:nodejs`.
   - Enforces `NODE_ENV=production`, `PORT=3000`, `HOSTNAME=0.0.0.0`.
   - Drops all root privileges: `USER nextjs`.

### Credential Hygiene (`.dockerignore`)
The `.dockerignore` file strictly excludes all local environment files, secrets, build artifacts, and caches:
```dockerignore
.git
.github
node_modules
.next
out
.env*
!.env.example
scratch
tmp
.cache
*.tsbuildinfo
coverage
*.log
```

---

## 3. MiniLM ONNX Model Pre-Caching & Strict Offline Verification

### Local Model Artifact Completeness
The Hugging Face `Xenova/all-MiniLM-L6-v2` ONNX pipeline is pre-cached in `.cache/Xenova/all-MiniLM-L6-v2` (24.0 MB total). All 4 required artifacts are audited and present:
1. `config.json` (model architecture & metadata)
2. `tokenizer.json` (FastTokenizer vocabulary)
3. `tokenizer_config.json` (special tokens & padding configuration)
4. `onnx/model_quantized.onnx` (8-bit quantized ONNX inference graph, 22.9 MB)

### Runtime Strict Offline Guarantee (`src/lib/ai/embeddings.ts`)
```typescript
const { complete, missingFiles } = auditModelArtifacts(modelDir);
const isProduction = process.env.NODE_ENV === 'production' || process.env.STRICT_OFFLINE === 'true';

if (isProduction) {
  if (!complete) {
    throw new Error(
      `[Strict Offline Guarantee] Incomplete model artifacts for ${this.modelId} in ${modelDir}. Missing: [${missingFiles.join(', ')}]. ` +
      `Runtime downloads are strictly disabled in production. Ensure pre-caching succeeded during build.`
    );
  }
  const pipe = await pipeline('feature-extraction', this.modelId, {
    cache_dir: cacheDir,
    local_files_only: true, // Guarantees 0 network requests
  });
  return pipe;
}
```
In production, missing files cause an immediate, explicit error. Transformers.js is never permitted to fall back to Hugging Face CDN downloads.

---

## 4. Empirical Memory Profiling

Measurements conducted using `scripts/measure-memory.ts` on Node.js v20.18.0:

| Lifecycle Phase | RSS (MB) | Heap Total (MB) | Heap Used (MB) | % of 512 MB Render Free |
| :--- | :--- | :--- | :--- | :--- |
| **1. Baseline (Empty Process)** | 35.85 MB | 4.88 MB | 4.41 MB | 7.0% |
| **2. Module Import (`@xenova/transformers`)** | 56.41 MB | 10.13 MB | 9.32 MB | 11.0% |
| **3. Offline Model Load (Quantized ONNX Graph)** | 148.40 MB | 17.63 MB | 16.51 MB | 29.0% |
| **4. First Inference (Cold Inference)** | 185.70 MB | 26.63 MB | 20.89 MB | 36.3% |
| **5. Sustained Inference (10 Repeated Queries)** | 204.81 MB | 45.13 MB | 37.19 MB | 40.0% |

**Headroom Analysis:**
At peak inference (204.81 MB), the process consumes 40.0% of Render's 512 MB Free tier ceiling, leaving **~307 MB** available for Next.js HTTP handling and concurrent query execution.

---

## 5. Public API Error Security & IP Privacy

### Error Masking (`src/app/api/chat/route.ts`)
Anonymous public users never receive raw exception messages, provider details, or SQL errors:
```typescript
} catch (err: any) {
  const rawMsg = err?.message || 'Unknown internal error';
  const safeLogMsg = rawMsg
    .replace(/sk-[a-zA-Z0-9_\-]+/g, '[REDACTED]')
    .replace(/postgres(ql)?:\/\/[^@\s]+@/g, 'postgresql://[REDACTED]@');
  console.error('[Chat API Internal Error]', safeLogMsg);

  return NextResponse.json(
    { error: 'An internal error occurred while processing your request. Please try again later.' },
    { status: 500 }
  );
}
```

### IP Anonymization (`src/lib/rag/security.ts`)
To comply with GDPR and privacy standards, client IP addresses are masked before database insertion:
- IPv4: `192.168.1.100` -> `192.168.1.xxx`
- IPv6: `2001:db8:85a3::8a2e:370:7334` -> `2001:db8:85a3:xxxx:xxxx`
- Localhost: `127.0.0.1`

---

## 6. Production Migration Safety & Neon Guardrails

### Strict Host Validation (`scripts/migrate-production.ts`)
```typescript
export function validateProductionDbTarget(targetEnv: string, dbUrl: string) {
  // 1. Enforce TARGET_ENV
  if (targetEnv !== 'production' && targetEnv !== 'cloud') {
    return { valid: false, error: 'TARGET_ENV must be explicitly set to "production" or "cloud"' };
  }
  // 2. Reject localhost / local ports
  if (host === 'localhost' || host === '127.0.0.1' || dbUrl.includes(':5550')) {
    return { valid: false, error: 'Localhost targets are strictly rejected' };
  }
  // 3. Strictly require Neon endpoint
  if (targetEnv === 'production' && !host.endsWith('.neon.tech')) {
    return { valid: false, error: 'host is not a verified Neon PostgreSQL host (*.neon.tech)' };
  }
  return { valid: true, host };
}
```

### Single-Transaction Seeding
`seed-data.sql` contains `BEGIN;` at the top and `COMMIT;` at the bottom. The migration runner executes `client.query(seedSql)` directly without an outer `BEGIN`/`COMMIT`, eliminating nested transaction warnings and premature commits. All connection passwords are redacted in console logs.

---

## 7. Redis Budget Reservations & Concurrency

### Atomic Lua Scripts & Redis-Side Idempotency
- **Reservation Key:** `budget:deepseek:reservation:${dateKey}:${reservationId}`
- **State Machine:** `RESERVED` -> `COMMITTED` (via reconcile) or `RELEASED` (via release) or `RETAINED` (via retain).
- **Midnight UTC Rollover:** Every token retains its creation `dateKey`. Settle calls pass `token.dateKey`, ensuring cross-midnight requests update the original day's partition without skewing the new day's counter.
- **Fail-Closed on Network Failure:** `token.resolved` is only set to `true` AFTER Redis confirms settlement. If Redis times out or fails, `token.resolved` remains `false`, allowing callers to retry.
- **Provider Overage Bounds:** Strict pre-allocation check prevents dispatching requests if provisional cost exceeds budget. Immediate post-generation reconciliation blocks subsequent queries if the actual token cost crosses the ceiling. Strict `max_tokens: 1024` bounds the single-request maximum overshoot to under $0.001. Complete streaming hard caps require provider-side account balance limits.

---

## 8. Automated Test Verification Results

### Suite 1: Phase 5B Production Controls (`scripts/test-phase5b-controls.ts`)
- **Command:** `cmd /c npx tsx scripts/test-phase5b-controls.ts`
- **Result:** **52 / 52 Passed (Exit Code 0)**
- **Coverage:**
  - Group 1: Admin Auth protection, bearer tokens, custom headers, 401/403 responses (7 tests)
  - Group 2: Budget reservations, Redis idempotency, concurrent reservations (40 requests against 5 slots), duplicate release prevention, duplicate reconcile prevention, midnight UTC rollover, nonnegative clamping, uncertain outcome retention (18 tests)
  - Group 3: Public API error sanitization, credential redaction, IP anonymization (10 tests)
  - Group 4: Migration host validation, localhost rejection, Neon enforcement, password sanitization, transaction wrapping (8 tests)
  - Group 5: Strict offline MiniLM model completeness, 4 required files, local_files_only enforcement (5 tests)
  - Group 6: Dockerfile multi-stage structure, non-root user, file permissions (4 tests)

### Suite 2: Seed Data Validation (`scripts/validate-seed-data.ts`)
- **Result:** **15 / 15 Passed (Exit Code 0)**
- **Verified:** 220 documents, 1,517 chunks, 384 dimensions, valid vector literals, HNSW index definitions.

### Suite 3: Next.js Production Build (`npm run build`)
- **Result:** **Exit Code 0 (Success)**
- **Compiled Routes:**
  - `○ /` (Static, 6.1 kB / 106 kB First Load JS)
  - `○ /_not-found` (Static, 896 B)
  - `ƒ /api/chat` (Dynamic, 145 B)
  - `ƒ /api/ingest` (Dynamic, 145 B)
  - `ƒ /api/jobs` (Dynamic, 145 B)
  - `ƒ /api/logs` (Dynamic, 145 B)

### Suite 4: TypeScript Typecheck (`npx tsc --noEmit`)
- **Result:** **Exit Code 0 (Zero Errors)**

### Suite 5: Phase 2 Regression Suite (`npm run test:phase2`)
- **Result:** **Exit Code 1 / Blocked**
- **Passed Tests:** Tests 1-3 passed (Corpus integrity, markdown & PDF parsers, chunking strategies).
- **Blocked Tests:** Tests 4-8 failed with `connect EACCES 127.0.0.1:5550` because Docker Desktop is stopped on the workstation host. Test 9 blocked on BullMQ Redis connection retry.

### Suite 6: Phase 3 Regression Suite (`npm run test:phase3`)
- **Result:** **Exit Code 1 / Blocked**
- **Blocked Tests:** Tests 1-6 failed with `connect EACCES 127.0.0.1:5550` because Docker Desktop is stopped on the workstation host. Test 7 blocked on Redis connection retry.

### Docker Runtime Status & Verification Limitations
- **Workstation Docker Engine Status:** `docker info` confirms the local Docker daemon is offline (`permission denied while trying to connect to the docker API at npipe:////./pipe/docker_engine`).
- **Explicit Unverified Boundary:** Actual Docker image build (`docker build`), runtime container memory measurement (cgroup RSS/memory limits), and offline model loading *inside a running Docker container* are **UNVERIFIED AT RUNTIME IN DOCKER**.
- **Verified Scope:** Buildability is confirmed via Next.js production build (`npm run build` Exit Code 0), offline model inference is empirically verified at the Node.js process level (peak RSS 204.81 MB), and Dockerfile/packaging directives are audited and unit-tested.

---

## 9. Target Cloud Deployment Architecture & Cost Analysis

| Component | Target Provider | Tier | Monthly Cost | Rationale / Constraints |
| :--- | :--- | :--- | :--- | :--- |
| **Web Service & Embeddings** | Render Docker Web Service | Free / Starter | **$0.00 / mo** (or $7/mo for Starter) | 512 MB RAM, runs Next.js + MiniLM ONNX. Free tier spins down after 15m of inactivity; Starter ($7/mo) runs continuously. |
| **Relational & Vector DB** | Neon PostgreSQL | Free Tier | **$0.00 / mo** | 0.5 GB storage, supports `pgvector` HNSW indexes. Never auto-pauses active projects. |
| **Rate Limiter & Budget DB** | Upstash Redis | Free Serverless | **$0.00 / mo** | 10,000 commands/day limit is well within single-query chat rate-limiting requirements. |
| **LLM Generation** | DeepSeek API | Pay-as-you-go | **<$0.50 / mo** | Funded by user's existing credits. Protected by $2.00/day hard budget cap. |
| **Ingestion Worker** | None (Pre-seeded) | N/A | **$0.00 / mo** | Entire corpus pre-seeded into Neon via `seed-data.sql`. Zero worker processes. |
| **TOTAL ESTIMATED COST** | | | **$0.00 / mo** (Free) or **$7.00 / mo** (Starter) |

---

## 10. Verification & Safety Confirmation

- [x] Work conducted strictly on feature branch `feat/grounded-production-deployment`.
- [x] No cloud services were provisioned or modified.
- [x] No cloud migrations were executed.
- [x] PR #2 PR review corrections verified and covered by tests.
- [x] All 52 Phase 5B controls assertions passed.
- [x] All 15 seed data assertions passed.
- [x] TypeScript typecheck passed with zero errors (`tsc --noEmit`).
- [x] Production build succeeded with zero errors (`npm run build`).
- [x] Docker runtime limitations and local container regression blocks documented explicitly.
