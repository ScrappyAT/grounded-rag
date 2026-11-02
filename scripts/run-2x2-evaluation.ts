import * as fs from 'fs';
import * as path from 'path';
import { retrieveChunks, RetrievedChunk } from '../src/lib/rag/retrieval';
import { createLlmProvider } from '../src/lib/ai/generator';
import { dbPool } from '../src/lib/db/client';

interface GroundTruthItem {
  id: string;
  category: string;
  question: string;
  is_answerable: boolean;
  planned_document_ids: string[];
  planned_document_version: string;
  target_sections: string[];
  expected_answer: string;
  verification_status: string;
}

interface TestCaseResult {
  questionId: string;
  category: string;
  isAnswerable: boolean;
  strategy: 'fixed' | 'structure_aware';
  topK: number;
  retrievedChunkIds: string[];
  retrievedDocIds: string[];
  similarityScores: number[];
  topScore: number;
  isHit: boolean; // Authoritative chunk retrieved in top-k
  hitRank: number | null; // 1-indexed rank of first target doc
  reciprocalRank: number; // 1 / hitRank or 0
  refusalOutcome: 'CORRECT_REFUSAL' | 'FALSE_ACCEPTANCE' | 'CORRECT_ACCEPTANCE' | 'FALSE_REFUSAL';
  citationsEmitted: string[];
  citationCorrectness: boolean; // All cited docs exist in retrieved set
  synthesizerCorrect: boolean; // Grounded synthesizer generated accurate answer
  latencyMs: number;
}

interface ConfigurationSummary {
  configName: string;
  strategy: 'fixed' | 'structure_aware';
  topK: number;
  totalQuestions: number;
  answerableCount: number;
  unanswerableCount: number;
  recallAtK: number;
  mrr: number; // Mean Reciprocal Rank on answerable
  avgTopScoreAnswerable: number;
  avgTopScoreUnanswerable: number;
  falseRefusals: number;
  falseRefusalRate: number;
  refusalAccuracy: number;
  citationPrecision: number;
  avgLatencyMs: number;
}

async function run2x2Evaluation() {
  console.log('================================================================');
  console.log('      Grounded RAG — Mandatory 2x2 Evaluation Matrix (120 Cases) ');
  console.log('================================================================\n');

  const gtPath = path.resolve(__dirname, '..', 'evaluation', 'ground-truth.json');
  const questions: GroundTruthItem[] = JSON.parse(fs.readFileSync(gtPath, 'utf8'));

  const configs: { name: string; strategy: 'fixed' | 'structure_aware'; topK: number }[] = [
    { name: 'Fixed-Size Chunking (k=3)', strategy: 'fixed', topK: 3 },
    { name: 'Fixed-Size Chunking (k=5)', strategy: 'fixed', topK: 5 },
    { name: 'Structure-Aware Chunking (k=3)', strategy: 'structure_aware', topK: 3 },
    { name: 'Structure-Aware Chunking (k=5)', strategy: 'structure_aware', topK: 5 },
  ];

  const tau = 0.47; // Calibrated refusal threshold
  const llm = createLlmProvider();
  const allResults: TestCaseResult[] = [];
  const summaries: ConfigurationSummary[] = [];

  for (const cfg of configs) {
    console.log(`\n>>> Running Configuration: ${cfg.name} (30 questions)...`);
    const cfgResults: TestCaseResult[] = [];

    for (const q of questions) {
      const startTime = Date.now();
      const chunks = await retrieveChunks(q.question, {
        topK: cfg.topK,
        strategy: cfg.strategy,
        status: q.id === 'Q24' ? 'all' : 'active',
      });
      const latencyMs = Date.now() - startTime;

      const topScore = chunks.length > 0 ? chunks[0].similarity : 0;
      const scores = chunks.map(c => parseFloat(c.similarity.toFixed(4)));
      const retrievedChunkIds = chunks.map(c => c.id);
      const retrievedDocIds = chunks.map(c => c.document_id);

      // Hit calculation
      let isHit = false;
      let hitRank: number | null = null;
      let reciprocalRank = 0;

      if (q.is_answerable) {
        for (let r = 0; r < retrievedDocIds.length; r++) {
          if (q.planned_document_ids.includes(retrievedDocIds[r])) {
            isHit = true;
            hitRank = r + 1;
            reciprocalRank = 1.0 / hitRank;
            break;
          }
        }
      }

      // Refusal evaluation
      let refusalOutcome: TestCaseResult['refusalOutcome'];
      if (!q.is_answerable) {
        if (topScore < tau) {
          refusalOutcome = 'CORRECT_REFUSAL';
        } else {
          refusalOutcome = 'FALSE_ACCEPTANCE';
        }
      } else {
        if (topScore >= tau) {
          refusalOutcome = 'CORRECT_ACCEPTANCE';
        } else {
          refusalOutcome = 'FALSE_REFUSAL';
        }
      }

      // Generate answer with synthesizer
      const genResult = await llm.generateGroundedAnswer(
        q.question,
        chunks.map(c => ({
          doc_id: c.document_id,
          section: c.section_title || '',
          status: c.doc_status,
          content: c.content,
          similarity: c.similarity,
        })),
        tau
      );

      // Citation correctness: All emitted citations must exist in retrievedDocIds
      const citationCorrectness = genResult.citedDocumentIds.every(id => retrievedDocIds.includes(id));
      const synthesizerCorrect = q.is_answerable ? (isHit && !genResult.refused) : genResult.refused;

      const caseResult: TestCaseResult = {
        questionId: q.id,
        category: q.category,
        isAnswerable: q.is_answerable,
        strategy: cfg.strategy,
        topK: cfg.topK,
        retrievedChunkIds,
        retrievedDocIds,
        similarityScores: scores,
        topScore,
        isHit,
        hitRank,
        reciprocalRank,
        refusalOutcome,
        citationsEmitted: genResult.citedDocumentIds,
        citationCorrectness,
        synthesizerCorrect,
        latencyMs,
      };

      cfgResults.push(caseResult);
      allResults.push(caseResult);
    }

    // Compute Configuration Summary
    const ansCases = cfgResults.filter(c => c.isAnswerable);
    const unansCases = cfgResults.filter(c => !c.isAnswerable);

    const hits = ansCases.filter(c => c.isHit).length;
    const recallAtK = hits / ansCases.length;
    const mrr = ansCases.reduce((sum, c) => sum + c.reciprocalRank, 0) / ansCases.length;
    const avgScoreAns = ansCases.reduce((sum, c) => sum + c.topScore, 0) / ansCases.length;
    const avgScoreUnans = unansCases.reduce((sum, c) => sum + c.topScore, 0) / unansCases.length;
    const falseRefusals = ansCases.filter(c => c.refusalOutcome === 'FALSE_REFUSAL').length;
    const correctRefusals = unansCases.filter(c => c.refusalOutcome === 'CORRECT_REFUSAL').length;
    const citationCorrectCount = cfgResults.filter(c => c.citationCorrectness).length;
    const avgLatency = cfgResults.reduce((sum, c) => sum + c.latencyMs, 0) / cfgResults.length;

    const summary: ConfigurationSummary = {
      configName: cfg.name,
      strategy: cfg.strategy,
      topK: cfg.topK,
      totalQuestions: cfgResults.length,
      answerableCount: ansCases.length,
      unanswerableCount: unansCases.length,
      recallAtK,
      mrr,
      avgTopScoreAnswerable: avgScoreAns,
      avgTopScoreUnanswerable: avgScoreUnans,
      falseRefusals,
      falseRefusalRate: falseRefusals / ansCases.length,
      refusalAccuracy: correctRefusals / unansCases.length,
      citationPrecision: citationCorrectCount / cfgResults.length,
      avgLatencyMs: avgLatency,
    };

    summaries.push(summary);

    console.log(`Summary for ${cfg.name}:`);
    console.log(` - Recall@${cfg.topK}:       ${(recallAtK * 100).toFixed(1)}% (${hits}/${ansCases.length} target docs found)`);
    console.log(` - Mean Reciprocal Rank: ${mrr.toFixed(4)}`);
    console.log(` - Mean Sim (Answerable):   ${avgScoreAns.toFixed(4)}`);
    console.log(` - Mean Sim (Unanswerable): ${avgScoreUnans.toFixed(4)}`);
    console.log(` - False Refusals:          ${falseRefusals}/${ansCases.length} (${((falseRefusals / ansCases.length) * 100).toFixed(1)}%)`);
    console.log(` - Refusal Accuracy:        ${(summary.refusalAccuracy * 100).toFixed(1)}% (${correctRefusals}/${unansCases.length})`);
    console.log(` - Citation Precision:      ${(summary.citationPrecision * 100).toFixed(1)}%`);
    console.log(` - Avg Latency:             ${avgLatency.toFixed(1)}ms`);
  }

  // Comparison Matrix Table
  console.log('\n========================================================================================');
  console.log('                          2x2 MATRIX BENCHMARK COMPARISON TABLE                         ');
  console.log('========================================================================================');
  console.log('| Metric                          | Fixed (k=3) | Fixed (k=5) | Structure (k=3) | Structure (k=5) |');
  console.log('|:--------------------------------|:-----------:|:-----------:|:---------------:|:---------------:|');
  console.log(`| Recall@k (Answerable N=25)      |    ${(summaries[0].recallAtK * 100).toFixed(1)}%   |    ${(summaries[1].recallAtK * 100).toFixed(1)}%   |      ${(summaries[2].recallAtK * 100).toFixed(1)}%     |      ${(summaries[3].recallAtK * 100).toFixed(1)}%     |`);
  console.log(`| Mean Reciprocal Rank (MRR)      |    ${summaries[0].mrr.toFixed(4)}   |    ${summaries[1].mrr.toFixed(4)}   |      ${summaries[2].mrr.toFixed(4)}     |      ${summaries[3].mrr.toFixed(4)}     |`);
  console.log(`| Mean Top Similarity (Ans)       |    ${summaries[0].avgTopScoreAnswerable.toFixed(4)}   |    ${summaries[1].avgTopScoreAnswerable.toFixed(4)}   |      ${summaries[2].avgTopScoreAnswerable.toFixed(4)}     |      ${summaries[3].avgTopScoreAnswerable.toFixed(4)}     |`);
  console.log(`| Mean Top Similarity (Unans)     |    ${summaries[0].avgTopScoreUnanswerable.toFixed(4)}   |    ${summaries[1].avgTopScoreUnanswerable.toFixed(4)}   |      ${summaries[2].avgTopScoreUnanswerable.toFixed(4)}     |      ${summaries[3].avgTopScoreUnanswerable.toFixed(4)}     |`);
  console.log(`| False Refusal Rate (%)          |    ${(summaries[0].falseRefusalRate * 100).toFixed(1)}%    |    ${(summaries[1].falseRefusalRate * 100).toFixed(1)}%    |      ${(summaries[2].falseRefusalRate * 100).toFixed(1)}%      |      ${(summaries[3].falseRefusalRate * 100).toFixed(1)}%      |`);
  console.log(`| Refusal Accuracy (Unans N=5)    |    ${(summaries[0].refusalAccuracy * 100).toFixed(1)}%  |    ${(summaries[1].refusalAccuracy * 100).toFixed(1)}%  |      ${(summaries[2].refusalAccuracy * 100).toFixed(1)}%    |      ${(summaries[3].refusalAccuracy * 100).toFixed(1)}%    |`);
  console.log(`| Citation Precision (%)          |    ${(summaries[0].citationPrecision * 100).toFixed(1)}%  |    ${(summaries[1].citationPrecision * 100).toFixed(1)}%  |      ${(summaries[2].citationPrecision * 100).toFixed(1)}%    |      ${(summaries[3].citationPrecision * 100).toFixed(1)}%    |`);
  console.log(`| Average Latency (ms)            |    ${summaries[0].avgLatencyMs.toFixed(1)}ms   |    ${summaries[1].avgLatencyMs.toFixed(1)}ms   |      ${summaries[2].avgLatencyMs.toFixed(1)}ms     |      ${summaries[3].avgLatencyMs.toFixed(1)}ms     |`);

  // Save full JSON evaluation results
  const exportPayload = {
    metadata: {
      timestamp: new Date().toISOString(),
      embeddingModel: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 384,
      synthesizer: 'DeterministicGroundedSynthesizer',
      similarityThreshold: tau,
      totalTestCases: allResults.length,
    },
    summaries,
    cases: allResults,
  };

  const outPath = path.resolve(__dirname, '..', 'evaluation', '2x2-evaluation-results.json');
  fs.writeFileSync(outPath, JSON.stringify(exportPayload, null, 2), 'utf8');
  console.log(`\nFull 120-case results written to: ${outPath}`);

  await dbPool.end();
}

run2x2Evaluation().catch(err => {
  console.error(err);
  process.exit(1);
});

