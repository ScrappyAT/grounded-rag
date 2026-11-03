import * as path from 'path';
import * as fs from 'fs';

async function precacheModel() {
  console.log('======================================================');
  console.log('       Grounded RAG — Pre-cache MiniLM ONNX Model     ');
  console.log('======================================================\n');

  const { pipeline, env } = await import('@xenova/transformers');
  const cacheDir = process.env.HF_CACHE_DIR || path.resolve(process.cwd(), '.cache');

  console.log(`Configuring Transformers.js cache directory: ${cacheDir}`);
  env.cacheDir = cacheDir;
  env.allowLocalModels = true;
  env.useBrowserCache = false;

  const modelId = 'Xenova/all-MiniLM-L6-v2';
  console.log(`Downloading and validating ONNX weights for ${modelId}...`);

  const start = Date.now();
  const pipe = await pipeline('feature-extraction', modelId, {
    cache_dir: cacheDir,
  });

  // Verify pipeline inference on sample text
  const testOutput = await pipe('ApexPay settlement verification test', {
    pooling: 'mean',
    normalize: true,
  });

  const duration = Date.now() - start;
  const vec = Array.from(testOutput.data) as number[];

  console.log(`\nModel successfully pre-cached and verified in ${duration}ms!`);
  console.log(`Output dimension: ${vec.length} (expected 384)`);

  const modelDir = path.join(cacheDir, 'Xenova', 'all-MiniLM-L6-v2');
  if (fs.existsSync(modelDir)) {
    const files = fs.readdirSync(modelDir, { recursive: true });
    console.log(`Cached files in ${modelDir}: ${files.length} items`);
  }

  process.exit(0);
}

precacheModel().catch(err => {
  console.error('Pre-caching error:', err);
  process.exit(1);
});
