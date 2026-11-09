/**
 * Grounded RAG — Refusal Banner Metadata & Classification
 *
 * Differentiates calibrated similarity-threshold refusals from security overrides,
 * insufficient-evidence knowledge boundaries, and operational quota limits.
 *
 * Ensures mathematically accurate comparison symbols:
 * - 'Score X < τ Y' is rendered ONLY when topSimilarity is strictly below threshold.
 * - 'Score X ≥ τ Y' is rendered when refusal occurs despite meeting or exceeding threshold.
 */

export interface RefusalMessageInput {
  content: string;
  refused?: boolean;
  refusalReason?: string;
  topSimilarity?: number;
  threshold?: number;
  retrievedChunks?: Array<{ id: string; similarity: number; [key: string]: any }>;
}

export type RefusalVariant =
  | 'below_threshold'
  | 'security'
  | 'insufficient_evidence'
  | 'budget'
  | 'generic';

export interface RefusalBannerInfo {
  title: string;
  badge?: string;
  variant: RefusalVariant;
  isBelowThreshold: boolean;
}

export function getRefusalBannerInfo(msg: RefusalMessageInput): RefusalBannerInfo {
  const hasScores = msg.topSimilarity !== undefined && msg.threshold !== undefined;
  const isBelowThreshold = hasScores && msg.topSimilarity! < msg.threshold!;

  // 1. Security & Adversarial Injection Override Gate
  const isSecurity =
    msg.content.includes('SECURITY NOTICE') ||
    msg.content.toLowerCase().includes('override attempt') ||
    msg.content.toLowerCase().includes('security override') ||
    Boolean(
      msg.refusalReason &&
        (msg.refusalReason.includes('SECURITY') ||
          msg.refusalReason.includes('ADVERSARIAL') ||
          msg.refusalReason.includes('OVERRIDE') ||
          msg.refusalReason.includes('INJECTION'))
    );

  if (isSecurity) {
    let badge: string | undefined;
    if (hasScores) {
      badge = isBelowThreshold
        ? `Score ${msg.topSimilarity!.toFixed(3)} < τ ${msg.threshold!.toFixed(2)}`
        : `Score ${msg.topSimilarity!.toFixed(3)} ≥ τ ${msg.threshold!.toFixed(2)}`;
    } else {
      badge = 'Security Directive';
    }

    return {
      title: 'Security Policy Gate Triggered: Injection Attempt Blocked',
      badge,
      variant: 'security',
      isBelowThreshold,
    };
  }

  // 2. Operational Limits & Budget Quotas
  const isBudget =
    msg.content.includes('[Budget Policy]') ||
    Boolean(
      msg.refusalReason &&
        (msg.refusalReason.includes('BUDGET') ||
          msg.refusalReason.includes('LIMIT') ||
          msg.refusalReason.includes('QUOTA'))
    );

  if (isBudget) {
    let badge = 'Quota Enforced';
    if (msg.refusalReason?.includes('DAILY_REQUEST_LIMIT')) {
      badge = 'Daily Request Limit Reached';
    } else if (msg.refusalReason?.includes('DAILY_BUDGET_LIMIT')) {
      badge = 'Daily Budget Limit Reached';
    } else if (msg.refusalReason?.includes('BUDGET_VERIFICATION_UNAVAILABLE')) {
      badge = 'Budget Service Unavailable';
    }

    return {
      title: 'Operational Policy Gate Triggered: Resource Limit Enforced',
      badge,
      variant: 'budget',
      isBelowThreshold,
    };
  }

  // 3. Calibrated Similarity Threshold Refusal (Below tau)
  if (isBelowThreshold) {
    return {
      title: 'Calibrated Evidence Refusal Gate Triggered',
      badge: `Score ${msg.topSimilarity!.toFixed(3)} < τ ${msg.threshold!.toFixed(2)}`,
      variant: 'below_threshold',
      isBelowThreshold: true,
    };
  }

  // 4. Above-Threshold Refusal (Insufficient Authoritative Evidence / Knowledge Boundary)
  if (hasScores && !isBelowThreshold) {
    return {
      title: 'Authoritative Evidence Gate Triggered: Insufficient Grounding',
      badge: `Score ${msg.topSimilarity!.toFixed(3)} ≥ τ ${msg.threshold!.toFixed(2)}`,
      variant: 'insufficient_evidence',
      isBelowThreshold: false,
    };
  }

  // 5. Zero Chunks Retrieved
  if (msg.refusalReason === 'NO_CHUNKS_RETRIEVED' || (msg.retrievedChunks && msg.retrievedChunks.length === 0)) {
    return {
      title: 'Zero Context Retrieved: Knowledge Base Search Inconclusive',
      badge: '0 Chunks Found',
      variant: 'insufficient_evidence',
      isBelowThreshold: false,
    };
  }

  // 6. Generic / Fallback Refusal
  return {
    title: 'Evidence Refusal Gate Triggered',
    badge: hasScores
      ? isBelowThreshold
        ? `Score ${msg.topSimilarity!.toFixed(3)} < τ ${msg.threshold!.toFixed(2)}`
        : `Score ${msg.topSimilarity!.toFixed(3)} ≥ τ ${msg.threshold!.toFixed(2)}`
      : undefined,
    variant: 'generic',
    isBelowThreshold,
  };
}

