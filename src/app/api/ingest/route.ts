import { NextResponse } from 'next/server';
import * as path from 'path';
import * as fs from 'fs';
import { enqueueBatch } from '@/lib/queue/ingestionQueue';
import { verifyAdminAuth, unauthorizedResponse, forbiddenResponse } from '@/lib/auth/adminAuth';

export async function POST(req: Request) {
  // In production web mode or explicit read-only mode, document ingestion is disabled
  if (process.env.READ_ONLY_MODE === 'true') {
    return forbiddenResponse('Document ingestion is disabled in production read-only mode.');
  }

  // Require administrative authentication in production or if ADMIN_API_KEY is configured
  if (process.env.NODE_ENV === 'production' || process.env.ADMIN_API_KEY) {
    if (!verifyAdminAuth(req)) {
      return unauthorizedResponse('Valid ADMIN_API_KEY required to trigger document ingestion.');
    }
  }

  try {
    const body = await req.json().catch(() => ({}));
    const forceReingest = Boolean(body.force);

    const corpusDir = path.resolve(process.cwd(), 'knowledge-base');
    const allFiles: string[] = [];

    const subdirs = fs.readdirSync(corpusDir).filter(f => fs.statSync(path.join(corpusDir, f)).isDirectory());
    for (const sub of subdirs) {
      const dirPath = path.join(corpusDir, sub);
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md') || f.endsWith('.pdf'));
      for (const file of files) {
        allFiles.push(path.join(dirPath, file));
      }
    }

    const jobs = await enqueueBatch(allFiles, forceReingest);

    return NextResponse.json({
      status: 'queued',
      enqueuedFilesCount: allFiles.length,
      jobCount: jobs.length,
      forceReingest,
    });
  } catch (err: any) {
    return NextResponse.json({ status: 'error', message: err.message }, { status: 500 });
  }
}

