import { LoadedDocument, computeSha256 } from '../loader';
import { GeneratedChunk, estimateTokenCount } from '../types';

export interface StructureChunkerOptions {
  maxSectionSize?: number; // In characters (default 800)
}

export function chunkStructureAware(
  doc: LoadedDocument, 
  options: StructureChunkerOptions = {}
): GeneratedChunk[] {
  const maxSectionSize = options.maxSectionSize || 800;
  const chunks: GeneratedChunk[] = [];
  let chunkIndex = 0;

  // Build standard contextual breadcrumb header (Anthropic contextual retrieval pattern)
  const headerLines = [
    `[DOCUMENT: ${doc.id} | TITLE: ${doc.title} | VERSION: ${doc.version} | STATUS: ${doc.status.toUpperCase()} | EFFECTIVE: ${doc.effective_date}]`,
    doc.supersedes ? `[SUPERSEDES: ${doc.supersedes}]` : null,
  ].filter(Boolean).join('\n');

  for (const section of doc.sections) {
    const sectionBreadcrumb = `${headerLines}\n[SECTION: ${section.title}]`;
    const fullSectionText = section.content.trim();

    if (fullSectionText.length === 0) continue;

    if (fullSectionText.length <= maxSectionSize) {
      const enrichedContent = `${sectionBreadcrumb}\n\n${fullSectionText}`;
      chunks.push({
        document_id: doc.id,
        strategy: 'structure_aware',
        chunk_index: chunkIndex++,
        content: enrichedContent,
        section_title: section.title,
        page_number: section.page,
        token_count: estimateTokenCount(enrichedContent),
        content_hash: computeSha256(enrichedContent),
        metadata: {
          title: doc.title,
          category: doc.category,
          department: doc.department,
          version: doc.version,
          status: doc.status,
          effective_date: doc.effective_date,
          supersedes: doc.supersedes,
          file_type: doc.file_type,
          section: section.title,
        },
      });
    } else {
      // Split by paragraphs (\n\n) if section exceeds maxSectionSize
      const paragraphs = fullSectionText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      let currentParagraphs: string[] = [];
      let currentLength = 0;
      let partIndex = 1;

      for (const p of paragraphs) {
        if (currentLength + p.length > maxSectionSize && currentParagraphs.length > 0) {
          const bodyText = currentParagraphs.join('\n\n');
          const enrichedContent = `${sectionBreadcrumb} (Part ${partIndex})\n\n${bodyText}`;
          chunks.push({
            document_id: doc.id,
            strategy: 'structure_aware',
            chunk_index: chunkIndex++,
            content: enrichedContent,
            section_title: `${section.title} (Part ${partIndex})`,
            page_number: section.page,
            token_count: estimateTokenCount(enrichedContent),
            content_hash: computeSha256(enrichedContent),
            metadata: {
              title: doc.title,
              category: doc.category,
              department: doc.department,
              version: doc.version,
              status: doc.status,
              effective_date: doc.effective_date,
              supersedes: doc.supersedes,
              file_type: doc.file_type,
              section: `${section.title} (Part ${partIndex})`,
            },
          });
          partIndex++;
          currentParagraphs = [p];
          currentLength = p.length;
        } else {
          currentParagraphs.push(p);
          currentLength += p.length + 2;
        }
      }

      if (currentParagraphs.length > 0) {
        const bodyText = currentParagraphs.join('\n\n');
        const enrichedContent = partIndex > 1 
          ? `${sectionBreadcrumb} (Part ${partIndex})\n\n${bodyText}`
          : `${sectionBreadcrumb}\n\n${bodyText}`;

        chunks.push({
          document_id: doc.id,
          strategy: 'structure_aware',
          chunk_index: chunkIndex++,
          content: enrichedContent,
          section_title: partIndex > 1 ? `${section.title} (Part ${partIndex})` : section.title,
          page_number: section.page,
          token_count: estimateTokenCount(enrichedContent),
          content_hash: computeSha256(enrichedContent),
          metadata: {
            title: doc.title,
            category: doc.category,
            department: doc.department,
            version: doc.version,
            status: doc.status,
            effective_date: doc.effective_date,
            supersedes: doc.supersedes,
            file_type: doc.file_type,
            section: partIndex > 1 ? `${section.title} (Part ${partIndex})` : section.title,
          },
        });
      }
    }
  }

  return chunks;
}

