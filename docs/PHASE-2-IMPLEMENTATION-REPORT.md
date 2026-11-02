# Grounded RAG — Phase 2 Implementation Report: Corpus & Ingestion Engine

**Project:** Grounded  
**Author:** Samuel Chinaza Emmanuel  
**Program:** Dev and Design HQ Product Design & Engineering Bootcamp (2026)  
**Specification:** Final Graduation Task — Part 4 (Pages 30–33)  
**Status:** Phase 2 Complete — Ready for Phase 3 Review  
**Date:** November 2, 2026  

---

## 1. Executive Summary

Phase 2 of the Grounded RAG system has been implemented and verified. All core data-plane, vector-indexing, and background-ingestion requirements from the graduation assessment brief have been fulfilled:

1. **Provider Preflight & Model Abstraction:** Implemented strict provider abstractions (`IEmbeddingProvider` and `ILlmProvider`) with configuration for `@google/genai` (`gemini-embedding-001` at 768 dimensions via MRL downscaling, and `gemini-2.5-flash`). Implemented a deterministic, offline `DeterministicMockEmbeddingProvider` (768-dim normalized unit vectors via SHA-256) ensuring 100% testable local development with zero API spend. Live Gemini calls are documented as blocked until a live API key is configured.
2. **Knowledge Base Generation (220 Documents):** Generated exactly 220 substantive, internally consistent documents for fictional fintech **ApexPay Technologies** across 8 departments (210 Markdown with Zod-validated YAML frontmatter, 10 PDFs with uncompressed standard Helvetica streams).
3. **Corpus Integrity & Manifest Verification:** Implemented `scripts/verify-corpus.ts`, generating `knowledge-base/manifest.json`. Verified all 220 document IDs, frontmatter schemas, cross-references (`supersedes: DOC-REF-002`), and content hashes. Audited all 30 evaluation questions in `evaluation/ground-truth.json`: 25 answerable questions verified against corpus text, and 5 unanswerable questions verified completely isolated.
4. **Vector Storage & HNSW Indexing:** Initialized PostgreSQL 16 with `pgvector` on host port `5550`. Built tables for `documents`, `chunks`, `embedding_cache`, and `query_logs`. Configured an HNSW index on `chunks.embedding` using `vector_cosine_ops` with parameters `m = 16, ef_construction = 64`.
5. **Dual Chunking Strategies:** Implemented Fixed-Size Sliding Window chunking (600 characters with 100-character overlap) and Structure-Aware Section chunking (Markdown heading and section splitting with contextual metadata breadcrumbs).
6. **Compound Cache & Deduplication:** Implemented compound-key embedding caching on `(content_hash, model_id, dimensions)` and SHA-256 document-level deduplication. Ingestion is idempotent: unchanged documents skip chunking and vector calculation entirely.
7. **Durable BullMQ Ingestion Queue:** Implemented Redis-backed queue (`ioredis` on host port `6395`) and persistent worker (`src/lib/queue/worker.ts`) with bounded exponential retries, crash recovery, and observable job progress reporting.
8. **Automated Test Suite:** Built and passed all 9 comprehensive automated tests in `scripts/run-phase2-tests.ts` (0 failures).
9. **Full Corpus Ingestion:** Executed `scripts/run-ingest.ts`, persisting 220 documents and **1,503 chunks** with full vector embeddings into PostgreSQL in 41.48 seconds.

---

## 2. File & Directory Inventory

The following files were created or modified during Phase 2:

```
grounded-rag/
├── .env                                  # Local development environment configuration
├── .env.example                          # Environment template with documented defaults
├── docker-compose.yml                    # Postgres (port 5550) + Redis (port 6395) definition
├── package.json                          # Dependencies (@google/genai, bullmq, unpdf, pdfkit, etc.)
├── README.md                             # Updated status and setup instructions
├── ARCHITECTURE.md                       # Updated with implementation specifics and ports
├── LEARNING-LOG.md                       # Phase 2 reflection prompts for explain-back
├── docs/
│   └── PHASE-2-IMPLEMENTATION-REPORT.md  # This document
├── evaluation/
│   └── ground-truth.json                 # 30-question ground truth audited & verified
├── knowledge-base/
│   ├── manifest.json                     # Reproducible 220-document manifest
│   ├── customer-support/                 # 30 Markdown documents
│   ├── account-management/               # 25 Markdown documents
│   ├── payments-settlements/             # 25 Markdown documents + 2 PDFs
│   ├── refunds-disputes/                 # 25 Markdown documents + 2 PDFs (incl. v1.0 & v2.0)
│   ├── fraud-security/                   # 25 Markdown documents + 2 PDFs (incl. DOC-SEC-ADV-999)
│   ├── product-operations/               # 25 Markdown documents + 2 PDFs
│   ├── compliance-legal/                 # 25 Markdown documents + 2 PDFs
│   └── hr-internal-policies/             # 30 Markdown documents
├── scripts/
│   ├── generate-corpus.ts                # 220-document generator (210 MD + 10 PDF)
│   ├── verify-corpus.ts                  # Zod schema validation & manifest generator
│   ├── init-db.ts                        # PostgreSQL + pgvector schema initializer
│   ├── run-ingest.ts                     # Full-corpus ingestion script
│   ├── run-phase2-tests.ts               # 9-suite automated Phase 2 test harness
│   └── test-connections.ts               # Docker container ping & diagnostics
└── src/
    ├── app/api/
    │   ├── jobs/route.ts                 # BullMQ job status & progress API
    │   └── ingest/route.ts               # Background batch ingestion trigger API
    └── lib/
        ├── ai/
        │   ├── embeddings.ts             # Provider abstraction, Gemini & Mock embeddings, Dimension Guard
        │   └── generator.ts              # Provider abstraction, Gemini & Mock LLM generators
        ├── db/
        │   ├── client.ts                 # pg.Pool connection singleton
        │   └── schema.sql                # DDL for documents, chunks, cache, and query_logs
        ├── queue/
        │   ├── client.ts                 # ioredis connection singleton
        │   ├── ingestionQueue.ts         # BullMQ queue producer and job enqueuer
        │   └── worker.ts                 # Persistent BullMQ worker processor
        └── rag/
            ├── types.ts                  # Zod schemas, interfaces, and token estimator
            ├── loader.ts                 # Dual-format parser (gray-matter & unpdf)
            ├── chunkers/
            │   ├── fixedChunker.ts       # 600-char window with 100-char overlap
            │   └── structureChunker.ts   # Section/heading-based chunker with breadcrumbs
            └── ingestionService.ts       # Core document ingestion, invalidation & caching
```

---

## 3. AI Model Provider Preflight Status

| Component | Target Model | Provider / Library | Configured Dimension | Status / Quota Verification |
| :--- | :--- | :--- | :--- | :--- |
| **Embeddings (Production)** | `gemini-embedding-001` | `@google/genai` (v2.32.0) | 768 (MRL downscaled) | Configured in `src/lib/ai/embeddings.ts`. Live testing is **BLOCKED** until `GEMINI_API_KEY` is provided by user. Free tier: 15 RPM, $0.15/1M tokens paid. |
| **Embeddings (Development/Mock)** | `deterministic-mock-embedding` | In-memory SHA-256 Unit Vector | 768 | **ACTIVE & VERIFIED**. Generates deterministic, normalized 768-dim floats. Zero latency, $0.00 cost, 100% offline. |
| **Answer Generation (Production)** | `gemini-2.5-flash` | `@google/genai` (v2.32.0) | N/A (1M context) | Configured in `src/lib/ai/generator.ts`. Live testing is **BLOCKED** until `GEMINI_API_KEY` is provided by user. Free tier: 15 RPM, 1M TPM. |
| **Answer Generation (Development/Mock)** | `deterministic-mock-llm` | Contextual Mock Synthesizer | N/A | **ACTIVE & VERIFIED**. Synthesizes grounded responses with simulated citations and refusal strings for tests. |

### API Key Security Policy
- `GEMINI_API_KEY` is read strictly from `process.env.GEMINI_API_KEY`.
- No API keys are hardcoded, logged, or checked into version control.
- `.gitignore` strictly protects `.env`, `.env.local`, and credential files.

---

## 4. Corpus Count & Verification Evidence

The knowledge base was generated using `scripts/generate-corpus.ts` and audited by `scripts/verify-corpus.ts`.

### Department & File Distribution

| Department | Markdown (.md) | PDF (.pdf) | Total Documents | Core Policy Focus |
| :--- | :---: | :---: | :---: | :--- |
| Customer Support (`customer-support`) | 30 | 0 | 30 | Ticketing SLAs, Escalations, Phone Support, Complaints |
| Account Management (`account-management`) | 25 | 0 | 25 | KYC Tiers, 2FA, Business Accounts, Closure, API Keys |
| Payments & Settlements (`payments-settlements`) | 25 | 2 | 27 | T+1/T+2 Settlement, Cross-Border SWIFT, POS, Split Pay |
| Refunds & Disputes (`refunds-disputes`) | 25 | 2 | 27 | Refund Timelines (v1.0 vs v2.0), Chargebacks, Evidence |
| Fraud & Security (`fraud-security`) | 25 | 2 | 27 | AML Triggers, Velocity, Penetration Policy, DOC-SEC-ADV-999 |
| Product & Operations (`product-operations`) | 25 | 2 | 27 | Webhooks, Sandbox Environments, Batch Payouts, SLAs |
| Compliance & Legal (`compliance-legal`) | 25 | 2 | 27 | GDPR, PCI-DSS Level 1, Suspicious Activity, Subpoenas |
| HR & Internal Policies (`hr-internal-policies`) | 30 | 0 | 30 | Remote Work, Security Clearances, Leave, Hardware |
| **Total** | **210** | **10** | **220** | **100% of required scope** |

### Verified Invariants & Edge Cases
- **Unique Document IDs:** Exactly 220 unique alphanumeric IDs matching format `DOC-[DEPT]-[NUM]`.
- **Policy Version Precedence Test Case:**
  - Deprecated: `DOC-REF-002` (Refund Policy v1.0, 2024, deprecated: 3–5 days).
  - Authoritative: `DOC-REF-012` (Refund Policy v2.0, 2026, active: 5 days domestic / 14 days international).
  - Cross-reference verified: `DOC-REF-012` frontmatter contains `supersedes: DOC-REF-002`.
- **Adversarial Security Test Document:**
  - `DOC-SEC-ADV-999` (System Maintenance Protocol & Security Override Bulletin): Contains deliberate prompt-injection payloads attempting to force an override to a 1-hour refund window.
- **PDF Binary Processing:** All 10 PDFs were generated using uncompressed streams via `pdfkit` and verified to parse cleanly via `unpdf` without XRef corruption.

### Ground-Truth Evaluation Audit (30 Questions)
- **Answerable Questions (Q1–Q25):** 25/25 verified against existing corpus documents. Exact source IDs, section titles, and expected answers mapped and marked `VERIFIED_AGAINST_CORPUS`.
- **Unanswerable Questions (Q26–Q30):** 5/5 verified genuinely unanswerable. A full text search across all 220 corpus documents confirmed zero occurrences of forbidden topic terms (crypto/Bitcoin, pet bereavement, office daycare, satellite internet, stock options). Marked `GENUINELY_UNANSWERABLE_VERIFIED`.

---

## 5. Database Schema & Vector Indexing Details

The PostgreSQL 16 database running in Docker container `grounded-postgres` (host port `5550`) contains four core tables:

### 1. `documents` Table
- Stores document-level metadata, lifecycle status, and SHA-256 file hashes.
- `supersedes` column configured as an indexed soft-reference (`idx_documents_supersedes`), allowing documents to be ingested in any sequence without foreign key blocking.

### 2. `chunks` Table
- Stores sliced text segments, token counts, and 768-dimensional vector embeddings.
- Indexed by compound index `(document_id, strategy)`, content hash `idx_chunks_hash`, and GIN index on `metadata`.
- **Vector Index:** HNSW index using cosine distance:
  ```sql
  CREATE INDEX idx_chunks_embedding_hnsw ON chunks 
  USING hnsw (embedding vector_cosine_ops) 
  WITH (m = 16, ef_construction = 64);
  ```

### 3. `embedding_cache` Table
- Primary key: `(content_hash, model_id, dimensions)`.
- Prevents recalculating embeddings for identical text snippets across re-ingestion runs.
- Dimension-safe: Prevents returning vectors of wrong dimensionality if model settings change.

### 4. `query_logs` Table
- Captures query strings, retrieval strategies, top-k parameters, similarity scores, refusal flags, latency, token counts, and cost metrics for observability.

### Ingestion Metric Baseline
Running `scripts/run-ingest.ts` produced the following baseline:
- Total documents ingested: **220**
- Total chunks created: **1,503**
- Active vector index: `idx_chunks_embedding_hnsw` (1,503 indexed vectors)
- Total execution time: **41.48 seconds**

---

## 6. Automated Test Suite Results

The Phase 2 automated test suite (`scripts/run-phase2-tests.ts`) was executed against the running PostgreSQL and Redis containers. All 9 test suites passed:

```
======================================================
               Grounded RAG - Phase 2 Test Suite      
======================================================
[Config] Database: postgresql://postgres:***@127.0.0.1:5550/grounded_rag
[Config] Redis:    redis://127.0.0.1:6395
[Config] Model:    deterministic-mock-embedding (768 dimensions)

  ✓ 1. Corpus Integrity & Manifest Audit (883ms)
       - Validated 220 document frontmatter records against Zod schema
       - Verified 220 unique document IDs
       - Confirmed manifest.json hash integrity
       - Verified all 30 evaluation questions (25 mapped, 5 isolated)

  ✓ 2. Markdown & PDF Parsers (9ms)
       - Parsed Markdown frontmatter and markdown body via gray-matter
       - Decoded native PDF pages and text content via unpdf
       - Verified SHA-256 content hashing on both formats

  ✓ 3. Chunking Strategies (Fixed vs Structure-Aware) (2ms)
       - Validated Fixed Chunking (600-char window, 100-char overlap)
       - Validated Structure-Aware Chunking (heading hierarchy + metadata header)

  ✓ 4. Hash Deduplication & Model-Aware Embedding Cache (65ms)
       - Inserted vector into embedding_cache with compound key
       - Retrieved cached vector within float32 tolerance (< 1e-4)
       - Confirmed cache hits bypass embedding generation

  ✓ 5. Model & Dimension Mismatch Protection (6ms)
       - Verified Dimension Guard rejects mismatched vector sizes
       - Verified compound cache keys prevent stale vector retrieval

  ✓ 6. Idempotent Document Ingestion (89ms)
       - Ingested test document DOC-TEST-001 (created 2 chunks)
       - Re-ingested unchanged document; confirmed skipped (0 new chunks created)

  ✓ 7. Document Updates & Chunk Invalidation (89ms)
       - Modified document text and updated hash
       - Re-ingested document; verified old chunks deleted and new chunks created

  ✓ 8. Policy-Version Precedence & Conflict Isolation (121ms)
       - Ingested DOC-REF-002 (v1.0, 2024, deprecated: 3-5 days)
       - Ingested DOC-REF-012 (v2.0, 2026, active: 14 days international, supersedes DOC-REF-002)
       - Verified supersedes relationship and active status isolation in database

  ✓ 9. BullMQ Queue, Progress & Bounded Retries (53ms)
       - Enqueued job to BullMQ ingestion queue
       - Worker picked up job, emitted progress, and handled retries on simulated failure

======================================================
                 Test Run Summary                     
======================================================
Total: 9 | Passed: 9 | Failed: 0 (100% Pass Rate)
```

---

## 7. Financial & Infrastructure Cost Accounting

- **Development Phase Cost Incurred:** **$0.00**
- **Docker Containers:** Running locally (`grounded-postgres` on port 5550, `grounded-redis` on port 6395). Zero cloud infrastructure cost.
- **AI Model Tokens:** Generated via deterministic local mock provider. Zero Gemini API spend.
- **Estimated Production Cost:** Documented in [ARCHITECTURE.md](file:///c:/Users/HP/Desktop/grounded-rag/ARCHITECTURE.md) (~$35–$47/month for managed Neon/Supabase pgvector, persistent Redis, and worker hosting).

---

## 8. Unresolved Issues & Readiness for Phase 3

### Unresolved Items / Prerequisites for Live Provider Testing
- **Gemini API Key:** No live Gemini API key is currently supplied in `.env`. Provider adapter architecture and mock fallbacks are fully verified. Live Gemini testing will activate immediately when a valid key is provided without any code refactoring.

### Phase 3 Readiness Checklist
- [x] 220 substantive knowledge-base documents ready on disk.
- [x] PostgreSQL schema and HNSW vector index active with 1,503 chunks.
- [x] BullMQ queue and worker functional.
- [x] 30 evaluation ground-truth questions audited and locked.
- [x] All 9 automated tests passing.
- [x] Repository boundary strictly maintained (no other projects touched).

Phase 2 is formally complete. Awaiting user review and authorization to proceed to **Phase 3: Retrieval Pipeline, Calibrated Refusal Gate, Web Chat UI & Citation Inspector**.

