import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import matter from 'gray-matter';
import { extractText, getDocumentProxy } from 'unpdf';

export interface DocumentSection {
  title: string;
  content: string;
  page?: number;
}

export interface LoadedDocument {
  id: string;
  title: string;
  category: string;
  department: string;
  version: string;
  status: 'active' | 'deprecated';
  effective_date: string;
  supersedes?: string;
  file_path: string;
  file_type: 'markdown' | 'pdf';
  raw_content: string;
  content_hash: string;
  sections: DocumentSection[];
}

export function computeSha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function loadMarkdownFile(filePath: string, relativeBasePath?: string): Promise<LoadedDocument> {
  const fileBuffer = fs.readFileSync(filePath);
  const contentHash = computeSha256(fileBuffer);
  const rawString = fileBuffer.toString('utf8');
  const parsed = matter(rawString);
  const data = parsed.data;

  const relPath = relativeBasePath 
    ? path.relative(relativeBasePath, filePath).replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/');

  // Parse sections based on Markdown headers (## )
  const sections: DocumentSection[] = [];
  const lines = parsed.content.split('\n');
  let currentTitle = 'Introduction';
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentLines.length > 0) {
        sections.push({
          title: currentTitle,
          content: currentLines.join('\n').trim(),
        });
        currentLines = [];
      }
      currentTitle = line.replace(/^##\s+/, '').trim();
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({
      title: currentTitle,
      content: currentLines.join('\n').trim(),
    });
  }

  return {
    id: data.id || path.basename(filePath, '.md'),
    title: data.title || currentTitle,
    category: data.category || 'General',
    department: data.department || 'Operations',
    version: data.version || '1.0',
    status: (data.status === 'deprecated' ? 'deprecated' : 'active'),
    effective_date: data.effective_date || new Date().toISOString().split('T')[0],
    supersedes: data.supersedes || undefined,
    file_path: relPath,
    file_type: 'markdown',
    raw_content: parsed.content.trim(),
    content_hash: contentHash,
    sections,
  };
}

export async function loadPdfFile(filePath: string, relativeBasePath?: string): Promise<LoadedDocument> {
  const fileBuffer = fs.readFileSync(filePath);
  const contentHash = computeSha256(fileBuffer);
  const pdfProxy = await getDocumentProxy(new Uint8Array(fileBuffer));
  const { text } = await extractText(pdfProxy, { mergePages: true });

  const relPath = relativeBasePath 
    ? path.relative(relativeBasePath, filePath).replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/');

  const idMatch = text.match(/Document ID:\s*([A-Z0-9-]+)/i);
  const versionMatch = text.match(/Version:\s*([0-9.]+)/i);
  const statusMatch = text.match(/Status:\s*(ACTIVE|DEPRECATED)/i);
  const deptMatch = text.match(/Department:\s*([^|\n]+)/i);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const title = lines[0] || path.basename(filePath, '.pdf');

  // Extract sections from PDF text (looking for Section headers)
  const sections: DocumentSection[] = [];
  let currentTitle = 'Document Header';
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.match(/^Section\s*(\d+|[A-Za-z0-9: -]+):/i)) {
      if (currentLines.length > 0) {
        sections.push({
          title: currentTitle,
          content: currentLines.join(' ').trim(),
        });
        currentLines = [];
      }
      currentTitle = line;
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({
      title: currentTitle,
      content: currentLines.join(' ').trim(),
    });
  }

  return {
    id: idMatch ? idMatch[1].trim() : path.basename(filePath, '.pdf'),
    title: title,
    category: 'General',
    department: deptMatch ? deptMatch[1].trim() : 'Operations',
    version: versionMatch ? versionMatch[1].trim() : '1.0',
    status: statusMatch && statusMatch[1].toUpperCase() === 'DEPRECATED' ? 'deprecated' : 'active',
    effective_date: '2025-06-15',
    file_path: relPath,
    file_type: 'pdf',
    raw_content: text.trim(),
    content_hash: contentHash,
    sections,
  };
}

export async function loadDocument(filePath: string, relativeBasePath?: string): Promise<LoadedDocument> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md') {
    return loadMarkdownFile(filePath, relativeBasePath);
  } else if (ext === '.pdf') {
    return loadPdfFile(filePath, relativeBasePath);
  } else {
    throw new Error(`Unsupported document format: ${ext} for file: ${filePath}`);
  }
}

