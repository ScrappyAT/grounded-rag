import { NextResponse } from 'next/server';
import { z } from 'zod';
import { retrieveChunks } from '@/lib/rag/retrieval';
import { createLlmProvider } from '@/lib/ai/generator';
import { checkRateLimit } from '@/lib/rag/rateLimiter';
import { query } from '@/lib/db/client';
import { getEmbeddingConfig } from '@/lib/ai/embeddings';

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).optional().default(5),
  strategy: z.enum(['fixed', 'structure_aware', 'all']).optional().default('structure_aware'),
  department: z.string().optional(),
  category: z.string().optional(),
  status: z.enum(['active', 'deprecated', 'all']).optional().default('active'),
});

export async function POST(req: Request) {
  const startTime = Date.now();

  try {
    // 1. Per-client Rate Limiting
    const forwardedFor = req.headers.get('x-forwarded-for');
    const clientIp = forwardedFor ? forwardedFor.split(',')[0].trim() : '127.0.0.1';
    const rateLimit = await checkRateLimit(clientIp, 30);

    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: 'Rate limit exceeded. Please wait before submitting more questions.',
          resetSeconds: rateLimit.resetSeconds,
        },
        {
          status: 429,
          headers: { 'Retry-After': String(rateLimit.resetSeconds) },
        }
      );
    }

    // 2. Parse & Validate input
    const body = await req.json();
    const parseResult = ChatRequestSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request parameters', details: parseResult.error.format() },
        { status: 400 }
      );
    }

    const { message, topK, strategy, department, category, status } = parseResult.data;
    const similarityThreshold = parseFloat(process.env.SIMILARITY_THRESHOLD || '0.47');
    const embeddingConfig = getEmbeddingConfig();

    // 3. Vector Retrieval with Metadata Pre-Filtering
    const retrievedChunks = await retrieveChunks(message, {
      topK,
      strategy: strategy as any,
      department,
      category,
      status,
    });

    const topScore = retrievedChunks.length > 0 ? retrievedChunks[0].similarity : 0;
    const isBelowThreshold = topScore < similarityThreshold;

    // 4. Generate Grounded Answer or Refusal
    const llm = createLlmProvider();
    const contextItems = retrievedChunks.map(c => ({
      doc_id: c.document_id,
      title: c.doc_title,
      section: c.section_title || 'General',
      status: c.doc_status,
      effective_date: c.doc_effective_date,
      content: c.content,
      similarity: c.similarity,
    }));

    const result = await llm.generateGroundedAnswer(message, contextItems, similarityThreshold);
    const latencyMs = Date.now() - startTime;

    // 5. Build verifiable citation objects with original chunk links
    const citations = result.citedDocumentIds.map(docId => {
      const matchingChunk = retrievedChunks.find(c => c.document_id === docId);
      return {
        doc_id: docId,
        title: matchingChunk?.doc_title || docId,
        department: matchingChunk?.doc_department || 'Unknown',
        section: matchingChunk?.section_title || 'General',
        status: matchingChunk?.doc_status || 'active',
        similarity: matchingChunk?.similarity || 0,
      };
    });

    // 6. Persist query observability and token/cost metrics into query_logs
    const chunkIds = retrievedChunks.map(c => c.id);
    const scores = retrievedChunks.map(c => c.similarity);

    await query(
      `INSERT INTO query_logs (
        query_text, strategy, top_k, model_id, dimensions, retrieved_chunk_ids,
        similarity_scores, refused, refusal_reason, answer_text, cited_document_ids,
        latency_ms, prompt_tokens, completion_tokens, estimated_cost_usd, user_ip
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        message,
        strategy,
        topK,
        embeddingConfig.modelId,
        embeddingConfig.dimensions,
        chunkIds,
        scores,
        result.refused,
        result.refusalReason || null,
        result.answer,
        result.citedDocumentIds,
        latencyMs,
        result.promptTokens,
        result.completionTokens,
        result.estimatedCostUsd,
        clientIp,
      ]
    ).catch(err => console.error('[QueryLogs] Failed to record query log:', err));

    return NextResponse.json({
      answer: result.answer,
      refused: result.refused,
      refusalReason: result.refusalReason,
      topSimilarity: topScore,
      threshold: similarityThreshold,
      citations,
      retrievedChunks,
      llmProvider: llm.providerName,
      llmModel: llm.modelId,
      isNeuralLLM: llm.providerName === 'deepseek' || llm.providerName === 'gemini',
      metrics: {
        latencyMs,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        embeddingModel: embeddingConfig.modelId,
        embeddingDimensions: embeddingConfig.dimensions,
        llmProvider: llm.providerName,
        llmModel: llm.modelId,
        isNeuralLLM: llm.providerName === 'deepseek' || llm.providerName === 'gemini',
      },
    });
  } catch (err: any) {
    console.error('Chat endpoint error:', err);
    return NextResponse.json(
      { error: err.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

