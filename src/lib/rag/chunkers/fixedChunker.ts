import { LoadedDocument, computeSha256 } from '../loader';
import { GeneratedChunk, estimateTokenCount } from '../types';

export interface FixedChunkerOptions {
  chunkSize?: number; // In characters (default 600)
  overlap?: number;    // In characters (default 100)
}

export function chunkFixedSize(
  doc: LoadedDocument, 
  options: FixedChunkerOptions = {}
): GeneratedChunk[] {
  const chunkSize = options.chunkSize || 600;
  const overlap = options.overlap || 100;
  const text = doc.raw_content;
  const chunks: GeneratedChunk[] = [];

  if (text.length <= chunkSize) {
    const chunkText = text.trim();
    return [{
      document_id: doc.id,
      strategy: 'fixed',
      chunk_index: 0,
      content: chunkText,
      section_title: 'Full Document',
      token_count: estimateTokenCount(chunkText),
      content_hash: computeSha256(chunkText),
      metadata: {
        title: doc.title,
        category: doc.category,
        department: doc.department,
        version: doc.version,
        status: doc.status,
        effective_date: doc.effective_date,
        supersedes: doc.supersedes,
        file_type: doc.file_type,
        section: 'Full Document',
      },
    }];
  }

  let startIndex = 0;
  let chunkIndex = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + chunkSize;

    // Adjust to nearest whitespace boundary if not at end of text
    if (endIndex < text.length) {
      const nextSpace = text.lastIndexOf(' ', endIndex);
      if (nextSpace > startIndex + (chunkSize / 2)) {
        endIndex = nextSpace;
      }
    } else {
      endIndex = text.length;
    }

    const chunkContent = text.slice(startIndex, endIndex).trim();
    if (chunkContent.length > 0) {
      chunks.push({
        document_id: doc.id,
        strategy: 'fixed',
        chunk_index: chunkIndex++,
        content: chunkContent,
        section_title: `Chunk ${chunkIndex}`,
        token_count: estimateTokenCount(chunkContent),
        content_hash: computeSha256(chunkContent),
        metadata: {
          title: doc.title,
          category: doc.category,
          department: doc.department,
          version: doc.version,
          status: doc.status,
          effective_date: doc.effective_date,
          supersedes: doc.supersedes,
          file_type: doc.file_type,
          section: `Chunk ${chunkIndex}`,
        },
      });
    }

    if (endIndex >= text.length) {
      break;
    }

    startIndex = Math.max(startIndex + 1, endIndex - overlap);
  }

  return chunks;
}

