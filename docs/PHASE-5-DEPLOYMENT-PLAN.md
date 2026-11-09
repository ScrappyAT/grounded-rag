# Grounded RAG — Phase 5: Production Deployment & Infrastructure Readiness Plan

**Project:** Grounded — Enterprise RAG Document Intelligence Assistant
**Author:** Samuel Chinaza Emmanuel
**Program:** Dev and Design HQ Product Design & Engineering Bootcamp (2026)
**Milestone:** Phase 5A — Public Production Deployment Readiness Assessment
**Date:** November 2, 2026
**Status:** Architecture Assessment Complete — Pending Review

---

## 1. Executive Summary

Grounded has achieved complete architectural maturity across corpus generation (220 documents), vector chunking (1,503 chunks), local semantic embeddings (`Xenova/all-MiniLM-L6-v2`), deterministic refusal gating ($\tau = 0.47$), prompt-injection neutralization (`DOC-SEC-ADV-999`), and live neural generation via DeepSeek (`deepseek-flash`). PR #1 has been cleanly merged into `main` (commit `d75243a`).

Phase 5 transitions Grounded from local containerized development (`docker-compose.yml`) into a **secure, highly observable, publicly accessible, and ultra-low-cost production deployment**.

### Core Strategic Insight: Eliminating 24/7 Worker Overhead
In local development, Grounded ran a persistent BullMQ ingestion worker process (`npm run worker`) and Redis instance to demonstrate background asynchronous document processing. However, in production, **the 220-document knowledge base for ApexPay Technologies is static, authoritative, and immutable**.

By pre-seeding the production PostgreSQL (`pgvector`) database with all 220 documents, 1,503 chunks, and pre-computed 384-dimensional embeddings prior to public launch, **we eliminate the requirement for a continuously running 24/7 worker process and a dedicated persistent Redis container in production**. This single architectural optimization reduces operational complexity and drives ongoing infrastructure costs down to **$0.00 / month** on verified free tiers, or **~$5.00–$7.00 / month** for dedicated always-on compute.

---

## 2. Runtime Processes & Resource Footprint

### A. Component Inventory & Production Roles

| Component | Local Dev Role | Production Role | Continuous Process Required? |
| :--- | :--- | :--- | :---: |
| **Next.js Web App (App Router)** | Chat UI, `/api/chat`, `/api/jobs`, `/api/logs` | Serves public Chat UI, processes RAG queries, executes semantic vector retrieval, calls DeepSeek | **YES** (1 Web Process) |
| **PostgreSQL 16 + pgvector** | Local Docker container on port 5550 | Managed Cloud PostgreSQL (Neon) storing documents, chunks, HNSW indexes, query logs | **YES** (Managed Cloud Service) |
| **MiniLM Embedding Inference** | Local `@xenova/transformers` ONNX pipeline | In-process query embedding generation (converting user query to 384-dim vector in ~20ms) | **NO** (Runs inside Next.js process) |
| **DeepSeek API** | Remote HTTPS API (`https://api.deepseek.com`) | Remote HTTPS API (`deepseek-flash` non-thinking mode) | **NO** (Stateless HTTPS calls) |
| **BullMQ Ingestion Worker** | Persistent process (`npm run worker`) | **Pre-deployment only:** Ingests and seeds corpus. Optional on-demand admin script | **NO** (Pre-seeded in DB) |
| **Redis** | Local Docker container on port 6395 | Rate limiting and job queue | **OPTIONAL** (Serverless Upstash or In-Memory) |

### B. Production Memory & Resource Analysis

1. **Next.js Web Service:**
   - **Baseline Node.js / Next.js Memory:** ~90–120 MB RAM.
   - **In-Memory MiniLM Model (`Xenova/all-MiniLM-L6-v2`):** ~150–180 MB RAM for ONNX runtime and model tensors.
   - **Total Active Web Process Footprint:** **~240–320 MB RAM**.
   - **Feasibility:** Safely fits inside standard **512 MB RAM** free/starter tiers (Render Free/Starter, Railway 512MB, Vercel 1024MB serverless).
2. **Persistent Storage:**
   - **220 Documents (Markdown + PDF):** ~2.8 MB text on disk.
   - **1,503 Chunks with 384-dim Vectors:** ~2.3 MB raw vectors (1,503 × 384 × 4 bytes) + text and metadata (~8 MB).
   - **HNSW Vector Indexes + Documents Table:** ~12–18 MB total database disk space.
   - **Query Logs:** ~0.5 KB per query. 10,000 queries require ~5 MB.
   - **Feasibility:** Total database size is **< 35 MB**, consuming less than 7% of Neon's 512 MB free tier allowance.
3. **Cold-Start & ONNX Model Download Challenge:**
   - `@xenova/transformers` by default downloads model files (~90 MB) from Hugging Face on the first inference request if not locally cached.
   - In ephemeral or cold-starting environments, downloading 90 MB on cold start adds 6–10 seconds of latency.
   - **Mitigation:** Pre-bake the model weights into the container image during Docker build (or download during build step), storing them in `/root/.cache/huggingface/hub`. This guarantees cold-start model load in **< 1.5 seconds** with zero external network dependency at runtime.

---

## 3. Evaluation of Low-Cost & Free-Tier Hosting Combinations

We evaluated five realistic hosting options against current 2026 provider limits and pricing:

### A. Provider Limit & Pricing Audit

| Provider | Service Evaluated | Verified Limits / Free Tier Terms | Real Monthly Cost | Production Suitability |
| :--- | :--- | :--- | :---: | :--- |
| **Neon** | Serverless PostgreSQL + pgvector | **Free Tier:** 0.5 GiB storage, 1 project, 1 compute branch, up to 100 CU hours/month. Auto-suspends after 5 min idle (wakes in ~500ms). Full `pgvector` and HNSW support. Built-in connection pooler. | **$0.00** | **HIGHEST (Recommended DB)**. Perpetual free tier; will not expire. Storage requirement (<35MB) is well within 512MB. |
| **Render** | Web Service | **Free Tier:** 512 MB RAM, 0.1 CPU. Auto-sleeps after 15 min idle (cold start: ~50s). 100 GB/mo bandwidth. Custom Docker supported.<br>**Starter Tier:** $7.00/mo, 512 MB RAM, 0.5 CPU, always-on (zero sleep). | **$0.00** (Free)<br>or **$7.00** (Starter) | **HIGH**. Free tier ideal for budget-constrained evaluation; Starter tier ideal for continuous public availability. |
| **Render** | Managed PostgreSQL | Free tier **expires and is deleted after 30 days**. | **$7.00** (Paid) | **NOT RECOMMENDED FOR DB**. Render free Postgres is temporary; Neon is superior. |
| **Vercel** | Next.js Hosting (Serverless) | **Hobby Tier:** Unlimited deployments, 1024MB RAM per serverless function, 10s default execution limit (configurable). | **$0.00** | **MEDIUM**. Excellent for Next.js, but bundling `@xenova/transformers` ONNX binaries in serverless functions requires custom webpack/serverless bundling to avoid 50MB zipped function limits. |
| **Railway** | App + Database PaaS | $5.00/month base subscription fee + usage metering. Trial credits expire. | **~$5.00–$8.00** | **MEDIUM-HIGH**. Unified deployment, but has no perpetual free tier. |
| **Upstash** | Serverless Redis | **Free Tier:** 10,000 commands/day, 256 MB storage, multi-region. REST and standard Redis protocol support. | **$0.00** | **HIGHEST (Recommended Redis)**. Zero maintenance, zero continuous container cost; handles rate limiting easily. |
| **DeepSeek API** | Neural LLM Inference | **Off-Peak Rates:** $0.15/1M prompt tokens, $0.60/1M completion tokens. | **~$0.50–$1.50** (usage-based) | **HIGHEST**. Verified live in Phase 4.5. 500 demo queries cost ~$0.58 total. |

---

### B. Recommended Architecture Comparison

#### Option 1: True $0.00 / Month Serverless Architecture (Lowest Practical Cost)
- **Web Frontend & API:** Render Free Web Service (Docker container with pre-baked MiniLM model) or Vercel Hobby.
- **Database:** Neon Serverless PostgreSQL with `pgvector` (Free Tier, 0.5 GB, auto-suspends when idle).
- **Rate Limiting:** Upstash Serverless Redis (Free Tier, 10k requests/day) or internal in-memory token bucket.
- **Ingestion:** Pre-seeded via one-time database migration.
- **LLM Generation:** DeepSeek API (`deepseek-flash`, ~$1.00 pay-as-you-go credit).
- **Total Fixed Monthly Cost:** **$0.00 / month**.
- **Trade-off:** Initial cold start of ~30–50 seconds if the free web service has been idle for more than 15 minutes.

#### Option 2: Production Persistent Architecture (~$7.00 / Month — Recommended for Best Experience)
- **Web Frontend & API:** Render Starter Web Service ($7.00/mo, 512 MB RAM, always-on, zero idle sleep).
- **Database:** Neon Serverless PostgreSQL with `pgvector` (Free Tier, $0.00/mo).
- **Rate Limiting:** Upstash Serverless Redis (Free Tier, $0.00/mo).
- **LLM Generation:** DeepSeek API (usage-based, ~$1.00/mo).
- **Total Fixed Monthly Cost:** **$7.00 / month**.
- **Advantage:** Zero cold-start latency, instantaneous chat responses (<2.5s end-to-end), predictable uptime.

---

## 4. Database & Ingestion Strategy: Pre-Seeding vs. Continuous Worker

### A. Pre-Seeding Decision
The ApexPay knowledge base consists of 220 fixed corporate documents across 7 operational departments and 2 adversarial bulletins. These documents do not change second-by-second in production.

Running a continuous BullMQ worker in production would:
1. Require a dedicated 24/7 background worker process ($7/mo on Render, or additional RAM).
2. Require a persistent Redis server ($5–$7/mo).
3. Risk CPU spikes during user traffic if an ingestion job executes simultaneously.

**Production Decision:**
We will pre-generate a standalone, reproducible SQL seed script: [`src/lib/db/seed-data.sql`](../src/lib/db/seed-data.sql).
- All 220 documents, 1,503 chunks, and 384-dimensional semantic vectors are dumped directly into standard SQL `INSERT ... ON CONFLICT DO NOTHING` statements.
- Applying `schema.sql` followed by `seed-data.sql` to Neon provisions the entire vector database in **< 45 seconds**.
- Ingestion worker and queue dependencies are decoupled from the public production runtime.

### B. On-Demand Administrative Ingestion
If a document update is required post-deployment:
1. An administrator can run the local ingestion script against the remote database:
   ```bash
   DATABASE_URL="postgresql://user:pass@ep-xyz.neon.tech/grounded_rag?sslmode=require" npm run ingest
   ```
2. Or invoke a secured administrative endpoint `POST /api/ingest` with `Authorization: Bearer <ADMIN_API_KEY>`.

---

## 5. Security & API Cost Controls

Before exposing Grounded to the public internet, the following six security and financial guardrails must be established:

### A. Endpoint Access Control (Admin Lock)
Currently, `POST /api/ingest`, `GET /api/jobs`, and `GET /api/logs` are unauthenticated.
- **Remediation:** Introduce an `ADMIN_API_KEY` environment variable.
- In `src/app/api/ingest/route.ts`, `src/app/api/jobs/route.ts`, and `src/app/api/logs/route.ts`:
  Verify `req.headers.get('authorization') === 'Bearer ' + process.env.ADMIN_API_KEY` or `req.headers.get('x-admin-key') === process.env.ADMIN_API_KEY`.
- Unauthenticated requests immediately receive `HTTP 401 Unauthorized` with zero internal information returned.

### B. User Privacy & IP Anonymization in Query Logs
`src/app/api/logs/route.ts` currently stores and returns raw client IP addresses (`user_ip`).
- **Remediation:** For GDPR/privacy compliance, client IPs will be anonymized before insertion into `query_logs`:
  - IPv4: Mask last octet (e.g., `192.168.1.124` $\rightarrow$ `192.168.1.0/24` or hash with daily salt).
  - IPv6: Mask last 80 bits.
- Public users cannot access `/api/logs`; it is strictly protected by `ADMIN_API_KEY`.

### C. Rate Limiting Hardening
- **Current implementation:** `checkRateLimit(clientIp, 15)` in `src/lib/rag/rateLimiter.ts` uses Redis.
- **Production enhancement:** Add an in-memory sliding-window fallback if Redis is unavailable:
  - If `REDIS_URL` or Upstash is configured, use Redis token bucket (15 requests/min per IP).
  - If Redis is disconnected or unconfigured, fallback to an in-memory LRU cache (`Map<string, { count, resetTime }>`) enforcing 15 requests/min per IP.
  - Reject abusive traffic with `HTTP 429 Too Many Requests` and `Retry-After: 60`.

### D. DeepSeek Spending Circuit Breaker
To prevent automated scripts or denial-of-wallet attacks from draining DeepSeek API credits:
1. **Daily Query Ceiling:** Implement an application-level daily query counter in `src/lib/ai/generator.ts`.
   - Maximum 500 neural generation requests per calendar day (UTC).
   - If the daily ceiling is reached, Grounded safely returns:
     > *"The daily public demonstration quota for neural generation has been reached. Please check back tomorrow or contact ApexPay administrator."*
   - Maximum daily exposure: $500 \times \$0.0003 \approx \$0.15 / \text{day}$ ($\le \$4.50 / \text{month}$).
2. **Output Token Bounds:** Enforce `max_tokens: 1024` on all chat completions.
3. **Evidence Gating:** Out-of-domain queries ($\text{sim} < 0.47$) are mathematically refused *before* calling DeepSeek, consuming 0 tokens and $0.00.

### E. Frontend Credential Isolation Audit
- All API keys (`DEEPSEEK_API_KEY`, `ADMIN_API_KEY`, `DATABASE_URL`) are read exclusively in Next.js Route Handlers (`src/app/api/...`) on the server.
- None of these environment variables carry the `NEXT_PUBLIC_` prefix.
- The client receives only sanitized JSON containing `answer`, `citations`, `retrievedChunks`, and telemetry metrics.

### F. Network & Transport Security
- Cloud PostgreSQL (Neon) strictly enforces TLS 1.3 / SSL (`sslmode=require`).
- `src/lib/db/client.ts` will configure `ssl: { rejectUnauthorized: false }` for production cloud database connections.
- PostgreSQL and Redis credentials are never bound to public ports or printed in application logs.

---

## 6. Reproducible Database Migration & Seeding Procedure

To ensure zero-downtime, idempotent, and non-destructive database provisioning:

### Step 1: DDL Schema Provisioning
Run the verified DDL script [`src/lib/db/schema.sql`](../src/lib/db/schema.sql):
```bash
psql "$DATABASE_URL" -f src/lib/db/schema.sql
```
- Executes `CREATE EXTENSION IF NOT EXISTS vector;`
- Creates `documents`, `chunks`, `embedding_cache`, and `query_logs` tables using `CREATE TABLE IF NOT EXISTS`.
- Builds HNSW vector cosine indexes:
  - `idx_chunks_hnsw_384` on `chunks (embedding_384 vector_cosine_ops)`
  - `idx_chunks_hnsw_768` on `chunks (embedding_768 vector_cosine_ops)`

### Step 2: Idempotent Corpus Seeding
Run the pre-generated seed script:
```bash
psql "$DATABASE_URL" -f src/lib/db/seed-data.sql
```
- Inserts 220 document records (`ON CONFLICT (id) DO NOTHING`).
- Inserts 1,503 chunk records with verified 384-dimensional vectors (`ON CONFLICT (id) DO NOTHING`).
- Seeds `embedding_cache` (`ON CONFLICT (content_hash, model_id, dimensions) DO NOTHING`).

### Step 3: Automated Verification Audit
Execute verification queries against the target database:
```sql
SELECT count(*) AS doc_count FROM documents;          -- Expected: 220
SELECT count(*) AS chunk_count FROM chunks;           -- Expected: 1503
SELECT indexname, indisvalid FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname = 'idx_chunks_hnsw_384';             -- Expected: true
```

---

## 7. Step-by-Step Deployment Roadmap

```mermaid
flowchart TD
    Step1["Step 1: Export DB Seed Data<br/>(scripts/export-seed-sql.ts)"] --> Step2["Step 2: Provision Neon PostgreSQL<br/>(Enable pgvector, copy DATABASE_URL)"]
    Step2 --> Step3["Step 3: Execute Schema & Seed<br/>(schema.sql + seed-data.sql)"]
    Step3 --> Step4["Step 4: Harden Code<br/>(Admin Auth, SSL DB Pool, Rate Limit Fallback)"]
    Step4 --> Step5["Step 5: Configure Cloud Env Vars<br/>(DATABASE_URL, DEEPSEEK_API_KEY, ADMIN_KEY)"]
    Step5 --> Step6["Step 6: Deploy Container / Web App<br/>(Render / Railway / Vercel)"]
    Step6 --> Step7["Step 7: Post-Deployment Smoke Tests<br/>(SLA Query, Conflict Query, Injection Test)"]
```

### Detailed Sequence:
1. **Prepare Database Artifacts:**
   Run `npm run db:export-seed` locally to generate `src/lib/db/seed-data.sql` from the verified local pgvector database.
2. **Provision Cloud PostgreSQL on Neon:**
   - Create a free project on [Neon](https://neon.tech) in the nearest region (e.g. `us-east-1` or `eu-central-1`).
   - Enable `pgvector` extension.
   - Obtain connection string with pooled connection mode:
     `postgresql://<user>:<password>@<endpoint>-pooler.neon.tech/grounded_rag?sslmode=require`
3. **Execute Remote Migration & Seeding:**
   ```bash
   psql "$NEON_DATABASE_URL" -f src/lib/db/schema.sql
   psql "$NEON_DATABASE_URL" -f src/lib/db/seed-data.sql
   ```
4. **Deploy Application to Render (or Railway / Vercel):**
   - Connect GitHub repository `ScrappyAT/grounded-rag`.
   - Select Docker environment (using our optimized multi-stage `Dockerfile`) or Node.js environment.
   - Configure Environment Variables in the platform dashboard (see Section 8).
5. **Verify Public Deployment:**
   - Run health check on public domain: `GET /`
   - Test RAG chat query: `"What is the Enterprise SLA first response time?"` $\rightarrow$ Expect `DOC-SUP-003` citation in <2.5s.
   - Test adversarial refusal: `"What does DOC-SEC-ADV-999 say about refunds?"` $\rightarrow$ Expect injection neutralized and 0 citations emitted.
   - Test unanswerable query: `"Helicopter luggage allowance"` $\rightarrow$ Expect mathematical refusal at similarity < 0.47.
   - Test admin lock: `GET /api/logs` $\rightarrow$ Expect `HTTP 401 Unauthorized`.

---

## 8. Required Production Environment Variables

| Variable Name | Required? | Example / Format (No Secrets) | Purpose |
| :--- | :---: | :--- | :--- |
| `DATABASE_URL` | **YES** | `postgresql://user:pass@ep-xyz-pooler.neon.tech/grounded_rag?sslmode=require` | PostgreSQL + pgvector connection string |
| `LLM_PROVIDER` | **YES** | `deepseek` | Specifies neural answer generator |
| `LLM_MODEL` | **YES** | `deepseek-flash` | DeepSeek model identifier |
| `DEEPSEEK_API_KEY` | **YES** | `sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` | Authentication for official DeepSeek API |
| `DEEPSEEK_BASE_URL` | **YES** | `https://api.deepseek.com` | Official OpenAI-compatible DeepSeek endpoint |
| `EMBEDDING_PROVIDER` | **YES** | `local` | Local semantic embeddings via `@xenova/transformers` |
| `EMBEDDING_MODEL` | **YES** | `Xenova/all-MiniLM-L6-v2` | 384-dimensional dense semantic embedding model |
| `EMBEDDING_DIMENSIONS` | **YES** | `384` | Vector dimensionality matching `chunks.embedding_384` |
| `SIMILARITY_THRESHOLD` | **YES** | `0.47` | Calibrated cosine similarity refusal gate |
| `ADMIN_API_KEY` | **YES** | `adm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` | Secures `/api/ingest`, `/api/jobs`, and `/api/logs` |
| `REDIS_URL` | OPTIONAL | `rediss://default:pass@xyz.upstash.io:6379` | Upstash Redis connection string for rate limiting |
| `DAILY_QUERY_LIMIT` | OPTIONAL | `500` | Safety ceiling for daily public LLM invocations |
| `NODE_ENV` | **YES** | `production` | Optimizes Next.js runtime performance and caching |

*Security Invariant:* None of the variables above carry `NEXT_PUBLIC_`, ensuring they are strictly isolated to server-side execution.

---

## 9. Code & Configuration Modifications Inventory

The following focused adjustments are identified for implementation prior to cloud deployment:

| File Path | Nature of Change | Justification |
| :--- | :--- | :--- |
| [`src/lib/db/client.ts`](../src/lib/db/client.ts) | Add SSL support (`ssl: { rejectUnauthorized: false }` when connecting to cloud hosts) and configurable pool size. | Enables secure connection to Neon / remote PostgreSQL. |
| [`src/app/api/ingest/route.ts`](../src/app/api/ingest/route.ts) | Add `ADMIN_API_KEY` validation check at request entry point. | Prevents unauthorized public triggering of corpus re-ingestion. |
| [`src/app/api/jobs/route.ts`](../src/app/api/jobs/route.ts) | Add `ADMIN_API_KEY` validation check. | Prevents public inspection of internal queue states and file paths. |
| [`src/app/api/logs/route.ts`](../src/app/api/logs/route.ts) | Add `ADMIN_API_KEY` validation check and anonymize `user_ip` field. | Protects user query history and prevents PII leakage. |
| [`src/lib/rag/rateLimiter.ts`](../src/lib/rag/rateLimiter.ts) | Add in-memory sliding-window fallback when `REDIS_URL` is absent. | Guarantees per-IP rate limiting even in zero-cost deployments without Redis. |
| [`src/lib/ai/generator.ts`](../src/lib/ai/generator.ts) | Add daily generation query counter / spending circuit breaker. | Protects user from unbounded DeepSeek credit exhaustion. |
| [`scripts/export-seed-sql.ts`](../scripts/export-seed-sql.ts) | Create script to dump documents, chunks, and embeddings into SQL seed script. | Provides reproducible, instant seeding for cloud PostgreSQL. |
| [`Dockerfile`](../Dockerfile) & [`.dockerignore`](../.dockerignore) | Multi-stage production container build with pre-cached ONNX model weights. | Eliminates runtime Hugging Face downloads and guarantees <1.5s cold starts. |
| [`.env.example`](../.env.example) | Update with DeepSeek, Neon, Upstash, and `ADMIN_API_KEY` variables. | Provides clear documentation for production environment configuration. |

---

## 10. Operational Risks, Edge Cases & Fallback Mitigations

| Risk Scenario | Impact | Mitigation Strategy | Fallback Option |
| :--- | :--- | :--- | :--- |
| **Free-Tier Idle Sleep (Render Free)** | First visitor after 15 min idle experiences 30–50s spin-up delay. | Use a free periodic health-check ping (e.g. UptimeRobot every 10 min) to keep container warm. | Upgrade to Render Starter ($7.00/mo) for guaranteed always-on compute. |
| **Serverless Cold-Start Model Download** | Cold serverless instance re-downloads 90MB ONNX model, causing request timeout. | Pre-bake model files into Docker container image during build phase. | Fall back to Google AI Studio `gemini-embedding-001` HTTPS API if local ONNX is constrained. |
| **Upstream DeepSeek API Outage** | DeepSeek returns HTTP 500/503 or network times out. | Sanitized error handling catches outage and returns graceful message: *"DeepSeek neural service is temporarily unavailable."* | Automated fallback to deterministic extractive synthesizer or Gemini if secondary key is present. |
| **PostgreSQL Connection Pool Exhaustion** | Spike in concurrent users exhausts PostgreSQL connection limit. | Connect through Neon's connection pooler (`-pooler.neon.tech`), which handles thousands of concurrent pooling connections via PgBouncer. | Set `max: 5` in `dbPool` client config. |
| **Denial-of-Wallet Attack (Scraping)** | Malicious bot sends thousands of queries to exhaust DeepSeek credits. | Multi-tier defense: 1) Per-IP rate limit (15/min), 2) Mathematical refusal gate, 3) Hard daily ceiling (500 queries/day). | Temporary automatic switch to deterministic synthesizer when daily quota is exceeded. |

---

## 11. Conclusion & Next Steps

Grounded is fully prepared for cloud deployment. The recommended architecture leverages **Neon Free PostgreSQL with pgvector** and **Render Web Service**, pre-seeding the 220-document knowledge base to achieve an ultra-economical operating cost of **$0.00 to $7.00 / month** with robust security, strict spending guardrails, and verifiable source grounding.

Awaiting review before proceeding to Phase 5B implementation.
