import * as crypto from 'crypto';
import { query } from '../db/client';

export interface IEmbeddingProvider {
  readonly providerName: string;
  readonly modelId: string;
  readonly dimensions: number;
  generateEmbedding(text: string): Promise<number[]>;
  generateBatchEmbeddings(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingConfig {
  provider: 'gemini' | 'mock' | 'local';
  modelId: string;
  dimensions: number;
  apiKey?: string;
}

export function getEmbeddingConfig(): EmbeddingConfig {
  const provider = (process.env.EMBEDDING_PROVIDER as 'gemini' | 'mock' | 'local') || 'local';
  const modelId = process.env.EMBEDDING_MODEL || (provider === 'local' ? 'Xenova/all-MiniLM-L6-v2' : 'gemini-embedding-001');
  const dimensions = parseInt(process.env.EMBEDDING_DIMENSIONS || (provider === 'local' ? '384' : '768'), 10);
  const apiKey = process.env.GEMINI_API_KEY || undefined;

  return { provider, modelId, dimensions, apiKey };
}

/**
 * Deterministic Mock Embedding Provider
 * Generates reproducible unit vectors of specified dimensions using cryptographic hashing.
 * Allows fast, isolated unit/infrastructure testing without downloading models or calling APIs.
 */
export class DeterministicMockEmbeddingProvider implements IEmbeddingProvider {
  readonly providerName = 'mock';
  readonly modelId: string;
  readonly dimensions: number;

  constructor(modelId = 'mock-embedding-768', dimensions = 768) {
    this.modelId = modelId;
    this.dimensions = dimensions;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions);
    const hash = crypto.createHash('sha256').update(text).digest();
    
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) {
      const byte1 = hash[i % hash.length];
      const byte2 = hash[(i + 7) % hash.length];
      const val = ((byte1 << 8) | byte2) / 65535.0 - 0.5;
      vector[i] = val;
      norm += val * val;
    }

    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        vector[i] = vector[i] / norm;
      }
    }

    return vector;
  }

  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.generateEmbedding(t)));
  }
}

/**
 * Genuine Local Semantic Embedding Provider
 * Uses Hugging Face ONNX Transformers via @xenova/transformers running 100% locally.
 * Generates genuine 384-dimensional dense semantic vectors (e.g. all-MiniLM-L6-v2).
 */
export class LocalSemanticEmbeddingProvider implements IEmbeddingProvider {
  readonly providerName = 'local';
  readonly modelId: string;
  readonly dimensions: number;
  private static pipelineInstance: any = null;
  private static loadingPromise: Promise<any> | null = null;

  constructor(modelId = 'Xenova/all-MiniLM-L6-v2', dimensions = 384) {
    this.modelId = modelId;
    this.dimensions = dimensions;
  }

  private async getPipeline() {
    if (LocalSemanticEmbeddingProvider.pipelineInstance) {
      return LocalSemanticEmbeddingProvider.pipelineInstance;
    }

    if (!LocalSemanticEmbeddingProvider.loadingPromise) {
      LocalSemanticEmbeddingProvider.loadingPromise = (async () => {
        const { pipeline, env } = await import('@xenova/transformers');
        // Configure local cache
        env.allowLocalModels = false;
        env.useBrowserCache = false;
        const pipe = await pipeline('feature-extraction', this.modelId);
        LocalSemanticEmbeddingProvider.pipelineInstance = pipe;
        return pipe;
      })();
    }

    return LocalSemanticEmbeddingProvider.loadingPromise;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const pipe = await this.getPipeline();
    const cleanText = text.replace(/\n+/g, ' ').trim();
    const output = await pipe(cleanText, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data) as number[];

    if (vector.length !== this.dimensions) {
      throw new Error(
        `Local model dimension mismatch: expected ${this.dimensions}, got ${vector.length}`
      );
    }

    return vector;
  }

  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.generateEmbedding(text));
    }
    return results;
  }
}

/**
 * Google Gemini Live Embedding Provider
 */
export class GeminiEmbeddingProvider implements IEmbeddingProvider {
  readonly providerName = 'gemini';
  readonly modelId: string;
  readonly dimensions: number;
  private apiKey: string;
  private genAiClient: any = null;

  constructor(apiKey: string, modelId = 'gemini-embedding-001', dimensions = 768) {
    this.apiKey = apiKey;
    this.modelId = modelId;
    this.dimensions = dimensions;
  }

  private async getClient() {
    if (!this.genAiClient) {
      const { GoogleGenAI } = await import('@google/genai');
      this.genAiClient = new GoogleGenAI({ apiKey: this.apiKey });
    }
    return this.genAiClient;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const ai = await this.getClient();
    const response = await ai.models.embedContent({
      model: this.modelId,
      contents: text,
      config: {
        outputDimensionality: this.dimensions,
      },
    });

    const values = response?.embedding?.values || response?.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
      throw new Error(`Gemini API returned empty embedding vector for model ${this.modelId}`);
    }

    if (values.length !== this.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.dimensions}, provider returned ${values.length}`
      );
    }

    return values;
  }

  async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const vector = await this.generateEmbedding(text);
      results.push(vector);
      await new Promise(r => setTimeout(r, 200));
    }
    return results;
  }
}

/**
 * Provider Factory
 */
export function createEmbeddingProvider(config = getEmbeddingConfig()): IEmbeddingProvider {
  if (config.provider === 'local') {
    return new LocalSemanticEmbeddingProvider(config.modelId, config.dimensions);
  }

  if (config.provider === 'gemini') {
    if (!config.apiKey || config.apiKey.includes('your_') || config.apiKey.trim() === '') {
      console.warn(
        '[AI PREFLIGHT] Valid GEMINI_API_KEY not detected. Using LocalSemanticEmbeddingProvider (Xenova/all-MiniLM-L6-v2) for genuine semantic embeddings.'
      );
      return new LocalSemanticEmbeddingProvider('Xenova/all-MiniLM-L6-v2', 384);
    }
    return new GeminiEmbeddingProvider(config.apiKey, config.modelId, config.dimensions);
  }

  const safeMockId = config.modelId.startsWith('mock-') ? config.modelId : `mock-${config.modelId}`;
  return new DeterministicMockEmbeddingProvider(safeMockId, config.dimensions);
}

/**
 * Model-Aware and Dimension-Guarded Embedding Cache
 */
export async function getOrGenerateEmbedding(
  text: string,
  contentHash: string,
  provider: IEmbeddingProvider
): Promise<number[]> {
  const colName = provider.dimensions === 384 ? 'embedding_384' : 'embedding_768';

  // 1. Check cache table with compound key (content_hash, model_id, dimensions)
  const cachedRows = await query(
    `SELECT ${colName} AS embedding FROM embedding_cache 
     WHERE content_hash = $1 AND model_id = $2 AND dimensions = $3`,
    [contentHash, provider.modelId, provider.dimensions]
  );

  if (cachedRows.length > 0 && cachedRows[0].embedding) {
    const rawVector = cachedRows[0].embedding;
    if (typeof rawVector === 'string') {
      return JSON.parse(rawVector);
    }
    return rawVector;
  }

  // 2. Generate new embedding
  const vector = await provider.generateEmbedding(text);

  // 3. Dimension Guard
  if (vector.length !== provider.dimensions) {
    throw new Error(
      `Dimension Guard Failure: Vector length ${vector.length} does not match provider dimensions ${provider.dimensions}`
    );
  }

  // 4. Save to cache
  const vectorString = `[${vector.join(',')}]`;
  await query(
    `INSERT INTO embedding_cache (content_hash, model_id, dimensions, ${colName})
     VALUES ($1, $2, $3, $4::vector)
     ON CONFLICT (content_hash, model_id, dimensions) 
     DO UPDATE SET ${colName} = EXCLUDED.${colName}`,
    [contentHash, provider.modelId, provider.dimensions, vectorString]
  );

  return vector;
}
