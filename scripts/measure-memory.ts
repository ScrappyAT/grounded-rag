import { createEmbeddingProvider } from '../src/lib/ai/embeddings';
import { createLlmProvider } from '../src/lib/ai/generator';

function formatMemory(mem: NodeJS.MemoryUsage) {
  return {
    rss: `${(mem.rss / (1024 * 1024)).toFixed(2)} MB`,
    heapTotal: `${(mem.heapTotal / (1024 * 1024)).toFixed(2)} MB`,
    heapUsed: `${(mem.heapUsed / (1024 * 1024)).toFixed(2)} MB`,
    external: `${(mem.external / (1024 * 1024)).toFixed(2)} MB`,
  };
}

async function measureMemory() {
  console.log('======================================================');
  console.log('       Grounded RAG — Memory Benchmark Audit          ');
  console.log('======================================================\n');

  // Baseline
  const memStartup = process.memoryUsage();
  console.log('1. Baseline Startup Memory:');
  console.table(formatMemory(memStartup));

  // Embedding Provider Initialization
  const embeddingProvider = createEmbeddingProvider();
  const memAfterInit = process.memoryUsage();
  console.log('\n2. Memory after Embedding Provider Instantiation:');
  console.table(formatMemory(memAfterInit));

  // First Inference
  const startFirst = Date.now();
  await embeddingProvider.generateEmbedding('What is the international SWIFT wire refund timeline?');
  const durFirst = Date.now() - startFirst;
  const memFirstInference = process.memoryUsage();
  console.log(`\n3. Memory after First Inference (${durFirst}ms):`);
  console.table(formatMemory(memFirstInference));

  // Repeated Inferences (10 iterations)
  const startRepeated = Date.now();
  for (let i = 0; i < 10; i++) {
    await embeddingProvider.generateEmbedding(`Query iteration ${i}: What are the Enterprise SLA terms and conditions?`);
  }
  const durRepeated = Date.now() - startRepeated;
  const memRepeated = process.memoryUsage();
  console.log(`\n4. Memory after 10 Sequential Inferences (${durRepeated}ms total, ${(durRepeated / 10).toFixed(1)}ms/query):`);
  console.table(formatMemory(memRepeated));

  // Refusal Generation
  const llm = createLlmProvider();
  await llm.generateGroundedAnswer('Unanswerable query', [], 0.47);
  const memRefusal = process.memoryUsage();
  console.log('\n5. Memory after Refusal Gating:');
  console.table(formatMemory(memRefusal));

  console.log('\n======================================================');
  console.log('Peak Resident Set Size (RSS):', `${(memRepeated.rss / (1024 * 1024)).toFixed(2)} MB`);
  console.log('Assessment vs 512 MB Container Limit:');
  if (memRepeated.rss < 400 * 1024 * 1024) {
    console.log(`  ✓ Peak RSS (${(memRepeated.rss / (1024 * 1024)).toFixed(2)} MB) is within 512 MB limit (${((memRepeated.rss / (512 * 1024 * 1024)) * 100).toFixed(1)}% of 512MB).`);
  } else {
    console.log(`  ⚠ Peak RSS (${(memRepeated.rss / (1024 * 1024)).toFixed(2)} MB) is tight for 512 MB.`);
  }
  console.log('======================================================');
  process.exit(0);
}

measureMemory().catch(err => {
  console.error('Measurement error:', err);
  process.exit(1);
});
