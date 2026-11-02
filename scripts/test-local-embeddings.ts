import { pipeline } from '@xenova/transformers';

async function main() {
  console.log('Testing local semantic embeddings with @xenova/transformers...');
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  const text1 = 'What is the refund timeline for international wire transfers?';
  const text2 = 'International wire refunds take 14 business days due to intermediary banks.';
  const text3 = 'Company employees may not bring pet cats or dogs to the office.';

  const out1 = await extractor(text1, { pooling: 'mean', normalize: true });
  const out2 = await extractor(text2, { pooling: 'mean', normalize: true });
  const out3 = await extractor(text3, { pooling: 'mean', normalize: true });

  const vec1: number[] = Array.from(out1.data);
  const vec2: number[] = Array.from(out2.data);
  const vec3: number[] = Array.from(out3.data);

  console.log(`Vector 1 dimensions: ${vec1.length}`);
  console.log(`Vector 2 dimensions: ${vec2.length}`);

  // Compute cosine similarities
  const dot = (a: number[], b: number[]) => a.reduce((sum, val, i) => sum + val * b[i], 0);

  const sim12 = dot(vec1, vec2);
  const sim13 = dot(vec1, vec3);

  console.log(`Cosine Similarity (Query vs Relevant Refund Passage): ${sim12.toFixed(4)}`);
  console.log(`Cosine Similarity (Query vs Irrelevant Pet Passage):    ${sim13.toFixed(4)}`);

  if (sim12 > 0.6 && sim13 < 0.3) {
    console.log('SUCCESS: Real semantic embeddings distinguish relevant vs irrelevant text!');
  } else {
    console.log('WARNING: Semantic distinction unexpected.');
  }
}

main().catch(err => {
  console.error('Error testing local embeddings:', err);
  process.exit(1);
});

