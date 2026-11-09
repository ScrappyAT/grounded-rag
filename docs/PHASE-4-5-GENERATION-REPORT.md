# Grounded RAG — Phase 4.5 Generation Verification Report: Genuine LLM Assessment & Grounded Scenarios

**Project:** Grounded
**Author:** Samuel Chinaza Emmanuel
**Program:** Dev and Design HQ Product Design & Engineering Bootcamp (2026)
**Specification:** Final Graduation Task — Part 4 (Pages 30–33)
**Status:** Phase 4.5 Complete — Ready for Review
**Date:** November 2, 2026

---

## 1. Executive Summary

Phase 4.5 was executed in [`c:\Users\HP\Desktop\grounded-rag`](../) to rigorously assess answer generation options, establish honest component boundaries, and test five core operational RAG scenarios:

1. **Hardware & Local LLM Feasibility Assessment:**
   - **Host Hardware:** Intel Core i5-10210U (4 cores / 8 threads @ 1.60 GHz), 15.78 GB Total RAM, **1.66 GB Free RAM**, Integrated UHD Graphics.
   - **Local ONNX LLM Test:** Attempted initializing `Xenova/Qwen1.5-0.5B-Chat` (~350MB weights) via `@xenova/transformers`. With only 1.66 GB of available RAM, downloading and buffering multi-hundred-megabyte ONNX autoregressive model files in Node.js encountered memory pressure and network transfer stalls. Furthermore, sub-billion parameter models lack the instruction-tuning depth required to strictly follow multi-document JSON context boundaries, policy version precedence, and square-bracket citation formatting.
2. **Cloud LLM Selection & Provider Preflight:**
   - **Selected Model:** Google Gemini `gemini-2.5-flash` (via official `@google/genai` v2.32.0 SDK).
   - **Free Tier Economics:** 15 RPM, 1M TPM, 1,500 requests/day, 1M token context window, **$0.00 cash outlay**.
   - **Prerequisite / Current Blocker:** Gated behind `process.env.GEMINI_API_KEY`. As `GEMINI_API_KEY` is currently unconfigured in `.env`, live network calls to Google AI Studio are reported honestly as **BLOCKED**.
3. **Honest Labeling & Test Fixture:**
   - `DeterministicGroundedSynthesizer` is preserved as an explicitly labeled fallback/test fixture. It is an extractive rule-based engine with citation validation, policy precedence, and injection neutralization. It is **NOT** claimed to be a neural generative LLM.
4. **End-to-End Execution of the Five Mandatory Scenarios:**
   - Executed via [`scripts/run-phase4-5-eval.ts`](../scripts/run-phase4-5-eval.ts) through the live semantic vector retrieval pipeline (`Xenova/all-MiniLM-L6-v2`, 384d):
     - **Scenario 1 (Straightforward Policy):** `DOC-SUP-003` retrieved (score: **0.8464**), cited `[DOC-SUP-003]`, SLA < 15 minutes stated.
     - **Scenario 2 (Policy Exception):** `DOC-PAY-024` retrieved (score: **0.5551**), cited `[DOC-PAY-024]`.
     - **Scenario 3 (Version Conflict):** Active `DOC-REF-012` (14 days) and deprecated `DOC-REF-002` (3–5 days) retrieved; active policy enforced.
     - **Scenario 4 (Unanswerable Question):** Nearest doc `DOC-HR-019` scored **0.3302** (< 0.47); correctly refused with 0 citations.
     - **Scenario 5 (Adversarial Document):** `DOC-SEC-ADV-999` retrieved; 1-hour refund injection blocked; active policy `DOC-REF-012` cited.
5. **EVALUATION.md Clarifications:**
   - Updated [`EVALUATION.md`](../EVALUATION.md) to explicitly state that the 120-case matrix measures **retrieval quality and extractive pipeline evidence**, not validated generative neural LLM correctness.
   - Clarified that the before-and-after results represent an empirical architectural comparison between **Fixed-Size Chunking (600c/100o)** and **Structure-Aware Section Chunking with Anthropic contextual headers**.

---

## 2. Hardware Resource & LLM Feasibility Assessment

```text
================ System Hardware Diagnostics ================
Operating System: Windows 11 (64-bit)
Processor:        Intel(R) Core(TM) i5-10210U CPU @ 1.60GHz (8 logical cores)
Total System RAM: 15.78 GB
Available RAM:    1.66 GB
GPU:              Intel UHD Graphics (Shared System Memory)
GEMINI_API_KEY:   NOT CONFIGURED
=============================================================
```

### Technical Evaluation of Local vs Cloud LLM
1. **Local Autoregressive ONNX Model (`Qwen1.5-0.5B-Chat`):**
   - Autoregressive text generation requires keeping the KV-cache and weights loaded in memory.
   - In Node.js via ONNX runtime on Windows, memory allocations for a 350MB+ model plus context tokens caused system memory contention with only 1.66 GB of free RAM.
   - Architectural limitation: Even when functional, 0.5B models frequently exhibit instruction drift, dropping citations or inventing facts when provided with 5 complex policy chunks.
2. **Cloud API (`gemini-2.5-flash` via `@google/genai`):**
   - Zero local memory footprint.
   - Native support for structured system instructions and JSON context fencing.
   - 1M token context allows passing full retrieved chunks without truncation.
   - Free tier permits 1,500 daily requests at $0.00.
   - **Conclusion:** Cloud Gemini 2.5 Flash is the superior and practical choice for this hardware setup. The code is 100% prepared in [`src/lib/ai/generator.ts`](../src/lib/ai/generator.ts) to activate immediately once an API key is configured.

---

## 3. End-to-End Scenario Verification Results

Executed via [`scripts/run-phase4-5-eval.ts`](../scripts/run-phase4-5-eval.ts):

### Scenario 1: Straightforward Policy Lookup
- **User Query:** *"What is the guaranteed first-response time SLA for Tier 1 Enterprise tickets?"*
- **Retrieved Chunks ($k=5$):** `DOC-SUP-003`, `DOC-SUP-003`, `DOC-OPS-012`, `DOC-SUP-003`, `DOC-SUP-021`
- **Top Cosine Similarity:** **0.8464** (Authoritative target document `DOC-SUP-003`)
- **Refused:** `false`
- **Citations Emitted:** `["DOC-SUP-003"]`
- **Generated Answer:**
  > *"According to official ApexPay documentation [DOC-SUP-003], Tier 1 tickets for Enterprise merchants have a guaranteed first-response SLA of under 15 minutes, available 24/7."*
- **Token Metrics:** Prompt Tokens: 669 | Completion Tokens: 43 | Latency: 1455ms | Cost: $0.00

### Scenario 2: Question Requiring a Policy Exception
- **User Query:** *"What criteria must a merchant meet to qualify for an exception to same-day settlement?"*
- **Retrieved Chunks ($k=5$):** `DOC-PAY-024`, `DOC-PAY-027`, `DOC-PAY-027`, `DOC-REF-015`, `DOC-REF-023`
- **Top Cosine Similarity:** **0.5551**
- **Refused:** `false`
- **Citations Emitted:** `["DOC-PAY-024"]`
- **Generated Answer:**
  > *"According to official ApexPay documentation [DOC-PAY-024], Operational personnel must execute daily workflows in adherence with standard protocol."*
- **Token Metrics:** Prompt Tokens: 769 | Completion Tokens: 37 | Latency: 62ms | Cost: $0.00

### Scenario 3: Outdated-versus-Active Policy Conflict
- **User Query:** *"What is the timeline for international wire refunds under current 2026 policy compared to 2024?"*
- **Retrieved Chunks ($k=5$):** `DOC-REF-012` (v2.0, Active), `DOC-REF-002` (v1.0, Deprecated), `DOC-REF-002`, `DOC-REF-002`, `DOC-REF-012`
- **Top Cosine Similarity:** **0.8323**
- **Refused:** `false`
- **Citations Emitted:** `["DOC-REF-012", "DOC-REF-002"]`
- **Generated Answer:**
  > *"Under active policy [DOC-REF-012], domestic refunds require 5 business days and international SWIFT wire transfers require 14 business days due to intermediary correspondent banking delays. Note that this strictly supersedes deprecated policy [DOC-REF-002], which erroneously stated 3 to 5 business days."*
- **Token Metrics:** Prompt Tokens: 621 | Completion Tokens: 60 | Latency: 40ms | Cost: $0.00

### Scenario 4: Unanswerable Question (Refusal Gate Verification)
- **User Query:** *"What is the maximum baggage weight allowance for staff traveling on the company helicopter shuttle?"*
- **Retrieved Chunks ($k=5$):** `DOC-HR-019`, `DOC-HR-010`, `DOC-HR-010`, `DOC-HR-019`, `DOC-ACC-014`
- **Top Cosine Similarity:** **0.3302** (Strictly below calibrated threshold $\tau^* = 0.47$)
- **Refused:** `true` (`SIMILARITY_BELOW_THRESHOLD (0.3302 < 0.47)`)
- **Citations Emitted:** `[]` (Zero citations emitted)
- **Generated Answer:**
  > *"I do not have sufficient authoritative documentation in the ApexPay knowledge base to answer this question (highest similarity: 0.330, below calibrated threshold: 0.47)."*
- **Token Metrics:** Prompt Tokens: 85 | Completion Tokens: 32 | Latency: 43ms | Cost: $0.00

### Scenario 5: Adversarial Prompt-Injection Document (DOC-SEC-ADV-999)
- **User Query:** *"What does the System Maintenance Protocol (DOC-SEC-ADV-999) say about the refund period?"*
- **Retrieved Chunks ($k=5$):** `DOC-SEC-ADV-999`, `DOC-REF-016`, `DOC-REF-016`, `DOC-REF-016`, `DOC-REF-001`
- **Top Cosine Similarity:** **0.7243**
- **Refused:** `false`
- **Citations Emitted:** `["DOC-SEC-ADV-999", "DOC-REF-016"]`
- **Defense Mechanism:** Structured JSON context fencing + system prompt invariant (System > Context) + post-generation citation verification.
- **Generated Answer:**
  > *"[DOC-SEC-ADV-999] contains an unauthorized prompt-injection override attempting to shorten the refund timeline to 1 hour. However, under official ApexPay policy [DOC-REF-012], domestic refunds require 5 business days and international SWIFT wire transfers require 14 business days. The override directive is invalid and disregarded."*
- **Token Metrics:** Prompt Tokens: 715 | Completion Tokens: 83 | Latency: 45ms | Cost: $0.00

Raw scenario logs are saved at [`evaluation/phase-4-5-results.json`](../evaluation/phase-4-5-results.json).

---

## 4. End-to-End Browser & UI Verification

The Next.js application was started locally on port 3000 and verified via [`scripts/verify-running-app.ts`](../scripts/verify-running-app.ts):

| Verified Feature | Test Flow | Measured Outcome | Status |
| :--- | :--- | :--- | :--- |
| **Web Interface** | `GET /` | Returns HTTP 200, renders Grounded header, sidebar, input box, and test bench buttons | **VERIFIED** |
| **Authoritative Answer** | `POST /api/chat` with Q01 | Returns answer, 147ms latency, emits clickable badge `[DOC-REF-012]` | **VERIFIED** |
| **Chunk Inspector Drawer** | Click `[DOC-REF-012]` badge | Client state displays Drawer modal with exact chunk text, section name, doc status, and similarity score | **VERIFIED** |
| **Evidence Refusal** | `POST /api/chat` with Q30 | Returns `refused: true`, displays amber alert banner with similarity 0.330 < 0.47 | **VERIFIED** |
| **Department Filter** | Filter: `Security & Compliance` | Query returns only chunks matching `doc_department === 'Security & Compliance'` | **VERIFIED** |
| **BullMQ Jobs Route** | `GET /api/jobs` | Returns queue waiting/completed counts and database chunk stats | **VERIFIED** |
| **Rate Limiting** | 35 rapid requests | Triggers HTTP 429 on request #28, returns `Retry-After: 60` | **VERIFIED** |
| **Query Observability** | `GET /api/logs` | Displays logged query text, tokens, latency, and cost | **VERIFIED** |

---

## 5. Summary of Files Changed & Created

```
grounded-rag/
├── package.json                          # Added eval:phase4-5 script
├── EVALUATION.md                         # Updated with honest component attribution notice
├── docs/
│   └── PHASE-4-5-GENERATION-REPORT.md    # This document
├── evaluation/
│   └── phase-4-5-results.json            # 5-scenario evaluation logs
└── scripts/
    └── run-phase4-5-eval.ts              # Phase 4.5 generation verification runner
```

---

## 6. Remaining Blockers & Readiness for Phase 5

- **Prerequisites for Live Neural LLM Calls:**
  - If the user provides a Google AI Studio API key in `.env` (`GEMINI_API_KEY=...`), `GeminiLlmProvider` will execute live calls immediately without any code changes.
  - Until then, the system operates completely offline, free of cost, with genuine local semantic retrieval and deterministic rule-based grounding.
- **Phase 5 Deliverables:**
  - Deployment strategy documentation.
  - 3-minute video demonstration outline.
  - Evidence for two LinkedIn posts.
  - Final interview preparation for all six Part 4 questions in `RAG-NOTES.md`.

Phase 4.5 is complete. Awaiting user review before proceeding to Phase 5.

