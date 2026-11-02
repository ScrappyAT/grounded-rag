import { z } from 'zod';

export type ChunkingStrategy = 'fixed' | 'structure_aware';

export interface GeneratedChunk {
  document_id: string;
  strategy: ChunkingStrategy;
  chunk_index: number;
  content: string;
  section_title: string;
  page_number?: number;
  token_count: number;
  content_hash: string;
  metadata: {
    title: string;
    category: string;
    department: string;
    version: string;
    status: 'active' | 'deprecated';
    effective_date: string;
    supersedes?: string;
    file_type: 'markdown' | 'pdf';
    section: string;
  };
}

export const ChunkSchema = z.object({
  document_id: z.string(),
  strategy: z.enum(['fixed', 'structure_aware']),
  chunk_index: z.number().int().nonnegative(),
  content: z.string().min(1),
  section_title: z.string(),
  page_number: z.number().optional(),
  token_count: z.number().int().positive(),
  content_hash: z.string().length(64),
  metadata: z.record(z.any()),
});

export function estimateTokenCount(text: string): number {
  // Approximate standard BPE tokens (~4 characters or ~0.75 words per token)
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words * 1.3));
}

