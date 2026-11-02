import { NextResponse } from 'next/server';
import * as path from 'path';
import * as fs from 'fs';
import { enqueueBatch } from '@/lib/queue/ingestionQueue';

export async function POST(req: Request) {
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

