import { query } from '../db/client';
import { createEmbeddingProvider, IEmbeddingProvider, getEmbeddingConfig } from '../ai/embeddings';

export interface RetrievalOptions {
  topK?: number;
  strategy?: 'fixed' | 'structure_aware' | 'all';
  department?: string;
  category?: string;
  status?: 'active' | 'deprecated' | 'all';
  corpusVersion?: string;
  modelId?: string;
  dimensions?: number;
  maxChunksPerDoc?: number;
}

export interface RetrievedChunk {
  id: string;
  document_id: string;
  doc_title: string;
  doc_category: string;
  doc_department: string;
  doc_version: string;
  doc_status: string;
  doc_effective_date: string;
  doc_supersedes: string | null;
  strategy: string;
  chunk_index: number;
  content: string;
  section_title: string | null;
  page_number: number | null;
  token_count: number;
  similarity: number;
  metadata: Record<string, any>;
}

export async function retrieveChunks(
  queryText: string,
  options: RetrievalOptions = {},
  embeddingProvider: IEmbeddingProvider = createEmbeddingProvider()
): Promise<RetrievedChunk[]> {
  const topK = options.topK || 5;
  const strategy = options.strategy && options.strategy !== 'all' ? options.strategy : null;
  const department = options.department || null;
  const category = options.category || null;
  const statusFilter = options.status === 'all' ? null : (options.status || 'active');
  const corpusVersion = options.corpusVersion || 'v1.0';
  const modelId = options.modelId || embeddingProvider.modelId;
  const dimensions = options.dimensions || embeddingProvider.dimensions;

  // 1. Generate query embedding
  const queryVector = await embeddingProvider.generateEmbedding(queryText);
  const vectorString = `[${queryVector.join(',')}]`;
  const colName = dimensions === 384 ? 'embedding_384' : 'embedding_768';

  // 2. Perform isolated vector cosine distance retrieval in PostgreSQL
  const sql = `
    SELECT 
      c.id,
      c.document_id,
      c.strategy,
      c.chunk_index,
      c.content,
      c.section_title,
      c.page_number,
      c.token_count,
      c.metadata,
      d.title AS doc_title,
      d.category AS doc_category,
      d.department AS doc_department,
      d.version AS doc_version,
      d.status AS doc_status,
      d.effective_date::text AS doc_effective_date,
      d.supersedes AS doc_supersedes,
      (1.0 - (c.${colName} <=> $1::vector)) AS similarity
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE c.model_id = $2
      AND c.dimensions = $3
      AND c.${colName} IS NOT NULL
      AND ($4::varchar IS NULL OR c.strategy = $4)
      AND ($5::varchar IS NULL OR d.department = $5)
      AND ($6::varchar IS NULL OR d.category = $6)
      AND ($7::varchar IS NULL OR d.status = $7)
      AND ($8::varchar IS NULL OR c.corpus_version = $8)
    ORDER BY c.${colName} <=> $1::vector ASC
    LIMIT $9
  `;

  const fetchLimit = options.maxChunksPerDoc ? Math.max(topK * 4, 30) : topK;

  const rows = await query(sql, [
    vectorString,
    modelId,
    dimensions,
    strategy,
    department,
    category,
    statusFilter,
    corpusVersion,
    fetchLimit,
  ]);

  const rawChunks: RetrievedChunk[] = rows.map((r: any) => ({
    id: r.id,
    document_id: r.document_id,
    doc_title: r.doc_title,
    doc_category: r.doc_category,
    doc_department: r.doc_department,
    doc_version: r.doc_version,
    doc_status: r.doc_status,
    doc_effective_date: r.doc_effective_date,
    doc_supersedes: r.doc_supersedes,
    strategy: r.strategy,
    chunk_index: r.chunk_index,
    content: r.content,
    section_title: r.section_title,
    page_number: r.page_number,
    token_count: r.token_count,
    similarity: parseFloat(r.similarity),
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata || {},
  }));

  if (options.maxChunksPerDoc && options.maxChunksPerDoc > 0) {
    const docCounts = new Map<string, number>();
    const diversified: RetrievedChunk[] = [];
    const skipped: RetrievedChunk[] = [];

    for (const chunk of rawChunks) {
      const count = docCounts.get(chunk.document_id) || 0;
      if (count < options.maxChunksPerDoc) {
        docCounts.set(chunk.document_id, count + 1);
        diversified.push(chunk);
        if (diversified.length >= topK) break;
      } else {
        skipped.push(chunk);
      }
    }

    // Safety: If distinct documents are exhausted before reaching topK,
    // backfill from skipped chunks to ensure relevant chunks are not discarded.
    if (diversified.length < topK && skipped.length > 0) {
      for (const chunk of skipped) {
        diversified.push(chunk);
        if (diversified.length >= topK) break;
      }
    }

    return diversified;
  }

  return rawChunks;
}

