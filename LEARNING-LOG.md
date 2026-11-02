# Learning Log: Grounded RAG Project

**Author:** Samuel Chinaza Emmanuel  
**Program:** Dev and Design HQ Product Design & Engineering Bootcamp (2026)  
**Task:** Final Graduation Task — Part 4 (RAG Project)  
**Assessment Rule 7:** "After AI helps you build something, close the chat and write a short paragraph explaining it in your own words. Save these paragraphs in a LEARNING-LOG.md file in each repo."

---

## Phase 1: Architecture, RAG Foundations & Evaluation Design

### Technical Decision: Why PostgreSQL with pgvector instead of a Dedicated Vector Database
> [!NOTE]
> Write a short paragraph in your own words explaining why we chose PostgreSQL with `pgvector` instead of a standalone vector database like Pinecone, Qdrant, or Chroma for Grounded. Mention connection pooling, transactional consistency (ACID), metadata pre-filtering, and your existing familiarity with PostgreSQL from Rota and Matinee.

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Structure-Aware Chunking vs Fixed-Size Sliding Windows
> [!NOTE]
> Write a short paragraph in your own words explaining the difference between fixed-size chunking and structure-aware chunking. Explain what happens when a sentence like *"Refunds take 5 days, except for international transfers which take 14 days"* gets cut across a fixed chunk boundary.

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Cosine Similarity Refusal Gate vs Pure LLM Refusal
> [!NOTE]
> Write a short paragraph in your own words explaining why Grounded computes a mathematical similarity threshold ($\tau = 0.68$) before even calling the LLM, rather than relying solely on the LLM to admit it doesn't know the answer.

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Defending Against Indirect Prompt Injections
> [!NOTE]
> Write a short paragraph in your own words explaining how an adversarial document inside a corporate knowledge base can hijack a RAG assistant, and how XML delimiter fencing and system prompt hardening neutralize that risk.

**My Explanation:**  
*[Write in your own words here]*

---

## Phase 2: Ingestion Engine, Vector Indexing & Corpus Verification

### Technical Decision: Dual-Format Parsing (Markdown vs PDF Streams)
> [!NOTE]
> Write a short paragraph in your own words explaining the difference between parsing structured Markdown frontmatter (via `gray-matter`) and decoding binary PDF page streams (via modern `unpdf`). Mention why legacy tools like `pdf-parse` fail on modern uncompressed streams and why reproducible hashing of raw file buffers is essential for idempotency.

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Single-Precision Vector Storage & Compound Embedding Caching
> [!NOTE]
> Write a short paragraph in your own words explaining why vector embeddings are stored as `vector(768)` (32-bit `float4`) in PostgreSQL while JavaScript runs 64-bit floats, and why compound caching on `(content_hash, model_id, dimensions)` is strictly necessary to prevent silent dimension corruption when switching embedding models.

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Decoupling Ingestion with BullMQ vs Synchronous API Handlers
> [!NOTE]
> Write a short paragraph in your own words explaining why ingesting 220 documents (1,500+ chunks) must be dispatched to a durable Redis-backed BullMQ queue rather than executed synchronously inside a Next.js serverless route handler. Mention bounded retries, worker crash recovery, and progress observability.

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Soft Version Precedence vs Strict Database Foreign Keys
> [!NOTE]
> Write a short paragraph in your own words explaining why we indexed the `supersedes` relationship column instead of using a rigid self-referencing foreign key constraint (`REFERENCES documents(id)`). Explain what happens when a newer policy document is ingested before its superseded predecessor.

**My Explanation:**  
*[Write in your own words here]*

---

## Phase 3: Retrieval Pipeline, Refusal Gate, Web Chat UI & Citations

### Technical Decision: Real Semantic Embeddings vs Hash-Based Deterministic Mocks
> [!NOTE]
> Write a short paragraph in your own words explaining the fundamental difference between cryptographic hash-based unit vectors (used for pipeline testing) and real semantic vector embeddings (e.g. `Xenova/all-MiniLM-L6-v2` via ONNX). Why can hash-based vectors never be used to evaluate retrieval recall or calibrate a cosine similarity threshold?

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Multi-Model Vector Isolation & Dynamic Dimension Partitioning
> [!NOTE]
> Write a short paragraph in your own words explaining how we prevented vector dimension collisions in PostgreSQL `pgvector`. Explain why we created dedicated columns (`embedding_384` and `embedding_768`) and compound filtering on `(model_id, dimensions, strategy, corpus_version)` instead of mixing all vectors together.

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Empirical Threshold Calibration vs Arbitrary Hardcoded Values
> [!NOTE]
> Write a short paragraph in your own words explaining how we determined the refusal threshold ($\tau^* = 0.47$). Contrast the score distribution of our 25 answerable questions (0.5011 to 0.9112) with our 5 unanswerable questions (0.3302 to 0.4447), and explain why this creates zero false refusals and 100% rejection of out-of-domain questions.

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Multi-Tier Defense Against Indirect Prompt Injections
> [!NOTE]
> Write a short paragraph in your own words explaining how Grounded defended against the adversarial document `DOC-SEC-ADV-999` (which attempted to override refund rules to 1 hour). Detail how pre-ingestion tag sanitization, structured JSON fencing, system prompt invariants, and post-generation citation verification worked together to defeat the attack.

**My Explanation:**  
*[Write in your own words here]*

---

## Phase 4: Evaluation Matrix, Model Provenance & Empirical Benchmarks

### Technical Decision: Model Provenance & Separating Mock from Semantic Vectors
> [!NOTE]
> Write a short paragraph in your own words explaining why it is critical for academic and engineering integrity to audit vector records and distinguish deterministic unit vector mocks from genuine semantic embeddings (e.g. `Xenova/all-MiniLM-L6-v2`). Explain what happened when initial mock vectors were stored under a cloud model identifier, and how we corrected the database schema and partition labels.

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Structure-Aware Chunking Superiority (Fixed vs Structure 2x2 Matrix)
> [!NOTE]
> Write a short paragraph in your own words explaining why Structure-Aware Chunking achieved an MRR of 1.0000 and 100% Recall@3, while Fixed-Size Chunking suffered a false refusal and dropped to 96% Recall@3 on Question Q06. Mention how Anthropic-style document headers and section boundaries preserve semantic context.

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Preventing Data Leakage in Threshold Calibration
> [!NOTE]
> Write a short paragraph in your own words explaining why we calibrated the refusal threshold ($\tau^* = 0.47$) on an independent 20-question calibration dataset before evaluating it on the official 30-question assessment dataset. What is "data leakage" in machine learning evaluation, and how did our sweep from 0.35 to 0.65 prove that 0.47 generalizes out-of-sample?

**My Explanation:**  
*[Write in your own words here]*

---

### Technical Decision: Honest Attribution of Answer Generation (Extractive vs Neural LLMs)
> [!NOTE]
> Write a short paragraph in your own words explaining the difference between our `DeterministicGroundedSynthesizer` (an extractive rules-and-guardrails engine) and a full generative neural LLM (like `gemini-2.5-flash`). Why is it vital not to claim that a rule-based synthesizer's correctness reflects LLM capability when the external API key is unconfigured?

**My Explanation:**  
*[Write in your own words here]*




