# Grounded — Verifiable RAG Document Intelligence Assistant

Grounded is an enterprise-grade Retrieval-Augmented Generation (RAG) assistant that answers complex operational, financial, and policy questions from a controlled collection of 220 corporate documents with verifiable, clickable citations.

---

## The Problem It Solves

Large language models deployed in corporate environments are prone to hallucinations, outdated assertions, and silent confabulations. Grounded solves this by strictly anchoring all answers in authoritative, versioned company policies for fictional fintech **ApexPay Technologies**.

Key capabilities:
- **Verifiable Citations:** Every factual statement links directly to an underlying document chunk, section title, and similarity score.
- **Deterministic Refusal:** When relevant evidence is missing or below a calibrated similarity threshold ($\tau^* = 0.47$, calibrated from an initial 0.68 baseline hypothesis), Grounded explicitly refuses to guess.
- **Policy Version Precedence:** Explicit version metadata and rules prevent deprecated policies (e.g. 2024 v1.0) from overriding newer authoritative policies (e.g. 2026 v2.0).
- **Dual Chunking Benchmarks:** Directly compares fixed-size sliding window chunking against structure-aware markdown/section chunking across multiple top-$k$ settings.
- **Multi-Tier Injection Defense:** Combines pre-ingestion text sanitization, structured data fencing, system prompt priority invariants, and post-generation citation verification to neutralize indirect prompt injection attacks.
- **Durable Ingestion & Caching:** Uses Redis/BullMQ background jobs with visible progress in development, skipping unchanged files via SHA-256 content hashes and caching vector embeddings with dimension guards.

---

## Tech Stack

- **Web Frontend & API:** Next.js 15+ (App Router), React 19, TypeScript, Tailwind CSS
- **Vector & Relational Database:**
  - **Production:** Managed **Neon PostgreSQL 18** with `pgvector 0.8.6` (AWS Europe West 2 London, HNSW cosine index, strict TLS certificate verification).
  - **Local Development:** PostgreSQL 16 with `pgvector` running via Docker Compose.
- **Distributed State & Rate Limiting:**
  - **Production:** Managed **Render Key Value (Valkey 8.1.10)** (Free Tier, Frankfurt) enforcing sliding-window rate limiting (10 req/min per IP) and atomic daily DeepSeek budget safeguards ($2.00 / 500 requests).
  - **Local Development:** Redis 7 with BullMQ (`ioredis`) in a dedicated persistent worker process (`npm run worker`) for background document parsing, embedding, and vector indexing.
- **AI Models:**
  - **Primary Generation:** DeepSeek `deepseek-flash` (via official OpenAI-compatible endpoint `https://api.deepseek.com`, configured with non-thinking mode for deterministic, cost-effective grounded synthesis with verifiable citations).
  - **Embeddings:** Hugging Face `Xenova/all-MiniLM-L6-v2` (384 dimensions, local semantic embedding pipeline via `@xenova/transformers` ONNX runtime; pre-cached during Docker image build).
  - **Offline Fallback:** `DeterministicGroundedSynthesizer` (`grounded-local-synthesizer-v1`) for isolated offline CI/CD and regression tests.
  - **Alternative Adapter:** Google Gemini `gemini-2.5-flash` via `@google/genai` (configurable via `LLM_PROVIDER=gemini`).
- **Validation & Parsing:** Zod v3, `unpdf` (PDF parser), `gray-matter` (frontmatter extraction)
- **Testing & Evaluation:** Custom 30-question evaluation harness (25 answerable, 5 unanswerable) and 120-case retrieval matrix across 4 configurations.

---

## Architecture Summary

```mermaid
flowchart LR
    A[Doc Ingestion: MD & PDF] --> B[SHA-256 Hasher & Deduplicator]
    B --> C[BullMQ Queue - Dev]
    C --> D[Chunking: Fixed vs Structure-Aware]
    D --> E[Embedding Cache & all-MiniLM-L6-v2 384d]
    E --> F[(Neon PostgreSQL 18 / PG + pgvector HNSW)]

    G[User Query] --> H[Render Valkey / Redis Rate Limiter]
    H --> I[Query Vectorization: all-MiniLM-L6-v2 384d]
    I --> J[pgvector Cosine Retrieval]
    J --> K{Top Similarity >= Calibrated Threshold tau = 0.47?}
    K -- No --> L[Grounded Refusal]
    K -- Yes --> M[Structured Data Fencing & DeepSeek deepseek-flash]
    M --> N[Answer + Verifiable Citations + Cost Logs]
```

Detailed technical specifications, worker process designs, and schema layouts are available in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Local Development & Setup

### Prerequisites
- Node.js v20+ (tested on Node.js v24.16.0)
- Docker Desktop (for local PostgreSQL with pgvector and Redis)
- DeepSeek API key (obtainable from [platform.deepseek.com](https://platform.deepseek.com/)) or Google AI Studio API key

### Step 1: Clone and Install Dependencies
```bash
git clone https://github.com/ScrappyAT/grounded-rag.git
cd grounded-rag
npm install
```

### Step 2: Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Fill in your `DEEPSEEK_API_KEY` (or `GEMINI_API_KEY` if using Google Gemini):
```env
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=sk-...
```

### Step 3: Start Local Infrastructure (PostgreSQL + pgvector & Redis)
```bash
docker-compose up -d
```

### Step 4: Start the Durable Ingestion Worker (Terminal 1)
```bash
npm run worker
```

### Step 5: Start the Web Application (Terminal 2)
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Production Deployment & Operational Architecture

The production application is deployed on **Render** with managed serverless infrastructure:
- **Live URL:** [https://grounded-rag-43ee.onrender.com/](https://grounded-rag-43ee.onrender.com/)

### Production Topology & Components
- **Web & Inference Service:** Render Free Docker Web Service (512 MB RAM, Frankfurt) running Next.js 15 App Router and local in-process ONNX MiniLM embedding inference. Model weights are pre-baked during the Docker build stage to eliminate runtime downloads and ensure cold start reliability.
- **Relational & Vector Storage:** Managed **Neon PostgreSQL 18** with `pgvector 0.8.6` (AWS Europe West 2 London, 0.5 GB storage, dimension-partitioned HNSW index on `embedding_384`). Connections enforce strict TLS (`sslmode=verify-full`).
- **Distributed State & Rate Limiting:** Managed **Render Key Value (Valkey 8.1.10)** (Free Tier, Frankfurt) over TLS (`rediss://`). Implements sliding-window rate limiting (10 req/min per IP) and atomic daily DeepSeek budget safeguards ($2.00 / 500 requests).
- **Generation Provider:** DeepSeek `deepseek-flash` (non-thinking mode, official endpoint `https://api.deepseek.com`).
- **Zero-Worker Pre-Seeded Corpus:** In production, the corpus of 220 documents (1,517 chunks and 1,185 embedding-cache entries) is pre-seeded into Neon PostgreSQL before launch using `src/lib/db/seed-data.sql`. The web service runs with `READ_ONLY_MODE=true`, disabling mutable ingestion routes (`/api/ingest`, `/api/jobs`) and completely eliminating the need for a continuously running BullMQ worker process. This keeps memory usage well within Render's 512 MB constraint.

### Render Free Valkey Limitations & Mitigations
- **Non-Persistent Storage:** Render Free Key Value operates entirely in RAM without disk persistence (no AOF or RDB snapshots). If the Valkey instance or container restarts, all stored Redis keys—including rate-limit token buckets and cumulative daily DeepSeek spend counters—are reset.
- **Fail-Closed Security Behavior:** If Redis/Valkey becomes unreachable, Grounded fails closed on administrative controls and logs connectivity failures rather than allowing unmetered generation.
- **Administrative Diagnostic Route:** A protected diagnostic endpoint (`/api/admin/diagnostics` / `/api/diagnostics`) requires `ADMIN_API_KEY` authentication and performs a non-mutating Redis `PING` with a strict 2,500ms timeout to verify connectivity without incrementing budget or rate counters.
- **Upstream Hard Budget Defense:** Because Valkey counters reset on restart, software budget enforcement is paired with hard billing limits (account pre-funding balance and daily spend limits) configured directly in the [DeepSeek Platform Console](https://platform.deepseek.com/), ensuring zero unexpected financial exposure.

### Production Docker Build & Run
```bash
# 1. Build the production Docker image (pre-caches MiniLM weights during build)
docker build -t grounded-rag:production .

# 2. Run container locally or push to Render
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@ep-xyz.eu-west-2.aws.neon.tech/grounded_rag?sslmode=require" \
  -e REDIS_URL="rediss://red-xyz:6379" \
  -e DEEPSEEK_BASE_URL="https://api.deepseek.com" \
  -e DEEPSEEK_API_KEY="sk-..." \
  -e LLM_PROVIDER="deepseek" \
  -e LLM_MODEL="deepseek-flash" \
  -e ADMIN_API_KEY="your-admin-secret" \
  -e READ_ONLY_MODE="true" \
  -e DAILY_BUDGET_USD="2.00" \
  -e DAILY_REQUEST_LIMIT="500" \
  grounded-rag:production
```

### Production Database Migration & Seeding
To populate a remote cloud database (Neon) with the 220 documents and 1,517 verified MiniLM embeddings:
```bash
TARGET_ENV=production DATABASE_URL="postgresql://user:pass@ep-xyz.eu-west-2.aws.neon.tech/grounded_rag?sslmode=require" npx tsx scripts/migrate-production.ts
```

---

## Realistic Cost Scenarios & Infrastructure Limits

1. **Local Development (Current Baseline):** $0.00 cash outlay via local Docker (PostgreSQL 16 + pgvector, Redis 7). Generation using DeepSeek API pay-as-you-go or local deterministic fallback.
2. **Hosted Prototype (Supabase + Upstash + Vercel):** $0.00 cash outlay, but subject to severe constraints (Supabase 7-day pause on inactivity, Upstash 10k daily command limit consumed rapidly by BullMQ polling, and Vercel inability to run a continuous background worker).
3. **Hosted Production Baseline (Render Free + Neon Free + Render Valkey Free):**
   - **Render Web Service (Free Docker):** $0.00/month (512 MB RAM, spins down after 15 minutes of inactivity; ~50s cold start).
   - **Neon PostgreSQL 18 (Free Tier):** $0.00/month (0.5 GB storage, serverless compute scaling).
   - **Render Key Value / Valkey 8.1.10 (Free Tier):** $0.00/month (25 MB RAM, non-persistent, resets on restart).
   - **DeepSeek API:** ~$0.0003 per query (~$0.30 per 1,000 queries with prompt caching and non-thinking mode).
   - **Total Base Hosting Cost:** **$0.00 / month**.
4. **Always-On Enterprise Production:** ~$35 – $47 / month for managed PostgreSQL with pgvector (Neon/Supabase Pro), persistent Redis (Redis Cloud / Upstash Pro), and persistent background worker host (Render / Railway / VPS) with zero cold starts.

---

## Project Status

- [x] **Phase 1: Architecture, Research & Evaluation Design** (Completed & Revised)
- [x] **Phase 2: Corpus Generation (220 docs), Ingestion Engine & Vector Indexing** (Completed & Verified)
- [x] **Phase 3: Retrieval Pipeline, Refusal Gate, Web Chat UI & Citations** (Completed & Verified)
- [x] **Phase 4: 120-Case Retrieval Benchmark & DeepSeek Generation Verification** (Completed & Verified)
- [x] **Phase 5A: Production Deployment Readiness & Architecture Plan** (Completed & Verified)
- [x] **Phase 5B: Deployment Implementation Preparation & Docker Packaging** (Completed & Verified)
- [x] **Phase 5C: Runtime Security Hardening & Strict Cloud Host Classification** (Completed & Verified)
- [x] **Phase 6: Cloud Migration & Live Verification (Render Web, Neon PG 18 + pgvector 0.8.6, Render Valkey)** (Completed & Verified)
- [x] **Phase 7: UI Refusal Banner Correction & Production Observability** (Completed & Verified)

---

## Part 4 Graduation Assessment Submission Checklist

This repository fulfills the requirements of **Part 4: Verifiable RAG System** of the Dev and Design HQ Product Design & Engineering Bootcamp (2026).

| # | Requirement | Deliverable / File | Status | Notes & Evidence Links |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **RAG Research Notes** | [`RAG-NOTES.md`](RAG-NOTES.md) | **Completed** | Full personal synthesis across all 13 core topics (Embeddings, Chunking, Vector Storage, Retrieval, Calibration, Prompt Hardening, Evaluation, Cost Analysis, etc.). |
| 2 | **RAG Pipeline Diagram** | [`RAG-NOTES.md`](RAG-NOTES.md#complete-rag-pipeline-diagram) & [`README.md`](#architecture-summary) | **Completed** | End-to-end Mermaid flowchart illustrating document ingestion, deduplication, chunking, caching, pgvector retrieval, calibrated refusal gate, data fencing, and DeepSeek synthesis. |
| 3 | **Project README** | [`README.md`](README.md) | **Completed** | Complete problem statement, tech stack, local setup, production architecture, cost scenarios, and status. |
| 4 | **Architecture Document** | [`ARCHITECTURE.md`](ARCHITECTURE.md) | **Completed** | In-depth technical specification, schema definitions, HNSW indexing parameters, prompt-injection defense tiers, and version conflict resolution hierarchy. |
| 5 | **Evaluation & Benchmark Matrix** | [`EVALUATION.md`](EVALUATION.md) | **Completed** | 120-case retrieval benchmark (fixed vs structure-aware, top-3 vs top-5), sensitivity calibration sweep ($\tau^* = 0.47$), and live DeepSeek neural evaluation logs. |
| 6 | **Learning Log** | [`LEARNING-LOG.md`](LEARNING-LOG.md) | **Completed** | 19 detailed, first-person explanations reflecting on key architectural decisions and engineering trade-offs across Phases 1 through 7. |
| 7 | **Live Deployed Application** | [Render Web Service](https://grounded-rag-43ee.onrender.com/) | **Completed** | Live public deployment on Render connected to Neon PostgreSQL 18 + pgvector 0.8.6 and Render Valkey 8.1.10. |
| 8 | **Demo Video Walkthrough** | Video URL | *Student Action Required* | [ ] *To be recorded and provided by the student upon final submission (screencast walking through query answering, clickable citations, calibrated refusal, version precedence, and prompt injection defense).* |
| 9 | **LinkedIn Post 1: Architecture & RAG Pipeline** | Post URL | *Student Action Required* | [ ] *To be published and provided by the student (technical breakdown of the verifiable RAG architecture, pgvector HNSW indexing, and calibrated refusal).* |
| 10 | **LinkedIn Post 2: Engineering Learnings & Graduation** | Post URL | *Student Action Required* | [ ] *To be published and provided by the student (reflection on prompt injection defense, production deployment trade-offs, and bootcamp completion).* |

> [!NOTE]
> Items 8, 9, and 10 represent external multimedia and social publications to be created and submitted by the student candidate. All codebase deliverables, architecture documents, evaluation datasets, and live cloud infrastructure are 100% verified and operational.
