import { Queue, QueueEvents } from 'bullmq';
import { redisConnection } from './client';

export const INGESTION_QUEUE_NAME = 'grounded-ingestion-queue';

export const ingestionQueue = new Queue(INGESTION_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: {
      count: 500,
    },
    removeOnFail: {
      count: 200,
    },
  },
});

export const ingestionQueueEvents = new QueueEvents(INGESTION_QUEUE_NAME, {
  connection: redisConnection,
});

export interface IngestionJobData {
  filePath: string;
  forceReingest?: boolean;
}

export async function enqueueDocument(filePath: string, forceReingest = false) {
  return ingestionQueue.add('ingest-file', { filePath, forceReingest });
}

export async function enqueueBatch(filePaths: string[], forceReingest = false) {
  const jobs = filePaths.map(filePath => ({
    name: 'ingest-file',
    data: { filePath, forceReingest },
  }));
  return ingestionQueue.addBulk(jobs);
}

export async function getQueueMetrics() {
  const [waiting, active, completed, failed] = await Promise.all([
    ingestionQueue.getWaitingCount(),
    ingestionQueue.getActiveCount(),
    ingestionQueue.getCompletedCount(),
    ingestionQueue.getFailedCount(),
  ]);

  return { waiting, active, completed, failed };
}

