-- PostgreSQL with pgvector schema for Grounded RAG
CREATE EXTENSION IF NOT EXISTS vector;

-- Drop foreign key constraint on supersedes if it was previously created
ALTER TABLE IF EXISTS documents DROP CONSTRAINT IF EXISTS documents_supersedes_fkey;

-- 1. Documents Table
CREATE TABLE IF NOT EXISTS documents (
    id VARCHAR(64) PRIMARY KEY,
    title TEXT NOT NULL,
    category VARCHAR(64) NOT NULL,
    department VARCHAR(64) NOT NULL,
    version VARCHAR(16) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    effective_date DATE NOT NULL,
    supersedes VARCHAR(64),
    file_path TEXT NOT NULL,
    file_type VARCHAR(16) NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    ingestion_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
CREATE INDEX IF NOT EXISTS idx_documents_department ON documents(department);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_effective_date ON documents(effective_date);
CREATE INDEX IF NOT EXISTS idx_documents_supersedes ON documents(supersedes);
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash);

-- 2. Chunks Table (Isolated storage for 384-dim and 768-dim models)
CREATE TABLE IF NOT EXISTS chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id VARCHAR(64) NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    strategy VARCHAR(32) NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    section_title TEXT,
    page_number INT,
    token_count INT NOT NULL,
    content_hash VARCHAR(64) NOT NULL,
    model_id VARCHAR(64) NOT NULL,
    dimensions INT NOT NULL,
    corpus_version VARCHAR(32) NOT NULL DEFAULT 'v1.0',
    metadata JSONB NOT NULL DEFAULT '{}',
    embedding_384 vector(384),
    embedding_768 vector(768),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_strategy ON chunks(document_id, strategy);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_chunks_model_dim ON chunks(model_id, dimensions);
CREATE INDEX IF NOT EXISTS idx_chunks_corpus_ver ON chunks(corpus_version);
CREATE INDEX IF NOT EXISTS idx_chunks_metadata ON chunks USING GIN (metadata);

-- HNSW Vector Indices for Cosine Distance (Dimension-Isolated)
CREATE INDEX IF NOT EXISTS idx_chunks_hnsw_384 ON chunks 
USING hnsw (embedding_384 vector_cosine_ops) 
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_chunks_hnsw_768 ON chunks 
USING hnsw (embedding_768 vector_cosine_ops) 
WITH (m = 16, ef_construction = 64);

-- 3. Embedding Cache Table (Compound-Key Partitioned by Model & Dimension)
CREATE TABLE IF NOT EXISTS embedding_cache (
    content_hash VARCHAR(64) NOT NULL,
    model_id VARCHAR(64) NOT NULL,
    dimensions INT NOT NULL,
    embedding_384 vector(384),
    embedding_768 vector(768),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (content_hash, model_id, dimensions)
);

-- 4. Query Observability & Audit Logs
CREATE TABLE IF NOT EXISTS query_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_text TEXT NOT NULL,
    strategy VARCHAR(32) NOT NULL,
    top_k INT NOT NULL,
    model_id VARCHAR(64) NOT NULL DEFAULT 'unknown',
    dimensions INT NOT NULL DEFAULT 384,
    retrieved_chunk_ids UUID[] NOT NULL,
    similarity_scores REAL[] NOT NULL,
    refused BOOLEAN NOT NULL DEFAULT FALSE,
    refusal_reason TEXT,
    answer_text TEXT,
    cited_document_ids TEXT[] NOT NULL DEFAULT '{}',
    latency_ms INT NOT NULL,
    prompt_tokens INT NOT NULL,
    completion_tokens INT NOT NULL,
    estimated_cost_usd NUMERIC(10, 6) NOT NULL,
    user_ip VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_query_logs_created_at ON query_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_query_logs_refused ON query_logs(refused);
