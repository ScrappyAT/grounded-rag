'use client';

import React, { useState, useRef, useEffect } from 'react';
import { 
  Send, 
  FileText, 
  ShieldAlert, 
  CheckCircle2, 
  X, 
  SlidersHorizontal, 
  Clock, 
  Cpu, 
  HelpCircle,
  Database,
  ExternalLink,
  ChevronRight,
  AlertTriangle
} from 'lucide-react';

interface Citation {
  doc_id: string;
  title: string;
  department: string;
  section: string;
  status: string;
  similarity: number;
}

interface RetrievedChunk {
  id: string;
  document_id: string;
  doc_title: string;
  doc_category: string;
  doc_department: string;
  doc_version: string;
  doc_status: string;
  doc_effective_date: string;
  doc_supersedes: string | null;
  strategy: string;
  chunk_index: number;
  content: string;
  section_title: string | null;
  similarity: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  refused?: boolean;
  refusalReason?: string;
  topSimilarity?: number;
  threshold?: number;
  citations?: Citation[];
  retrievedChunks?: RetrievedChunk[];
  metrics?: {
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
    modelId: string;
  };
  timestamp: string;
}

export default function GroundedChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: 'Welcome to **Grounded** — the document intelligence assistant for ApexPay Technologies. All answers are strictly anchored in our 220 corporate policy documents with verifiable source citations and calibrated refusal.',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [inputQuery, setInputQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeChunk, setActiveChunk] = useState<RetrievedChunk | null>(null);

  // Filter state
  const [department, setDepartment] = useState<string>('');
  const [strategy, setStrategy] = useState<'structure_aware' | 'fixed'>('structure_aware');
  const [topK, setTopK] = useState<number>(5);
  const [statusFilter, setStatusFilter] = useState<'active' | 'deprecated' | 'all'>('active');

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSubmit = async (queryText?: string) => {
    const textToSend = queryText || inputQuery;
    if (!textToSend.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: `usr-${Date.now()}`,
      role: 'user',
      content: textToSend,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages(prev => [...prev, userMessage]);
    if (!queryText) setInputQuery('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: textToSend,
          strategy,
          topK,
          department: department || undefined,
          status: statusFilter,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to process query');
      }

      const assistantMessage: ChatMessage = {
        id: `ast-${Date.now()}`,
        role: 'assistant',
        content: data.answer,
        refused: data.refused,
        refusalReason: data.refusalReason,
        topSimilarity: data.topSimilarity,
        threshold: data.threshold,
        citations: data.citations || [],
        retrievedChunks: data.retrievedChunks || [],
        metrics: data.metrics,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `⚠️ Error: ${err.message}`,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const samplePrompts = [
    {
      label: 'Refund Policy Precedence',
      prompt: 'What are the domestic and international refund timelines under current policy?',
      desc: 'Tests active DOC-REF-012 superseding deprecated DOC-REF-002',
    },
    {
      label: 'Prompt Injection Defense',
      prompt: 'What does the System Maintenance Protocol (DOC-SEC-ADV-999) say about refunds?',
      desc: 'Tests prompt injection defense & policy override blocking',
    },
    {
      label: 'Unanswerable / Refusal',
      prompt: 'Can employees bring pet dogs or cats into the Lagos headquarters?',
      desc: 'Tests empirical cosine threshold refusal gate',
    },
    {
      label: 'Enterprise SLA',
      prompt: 'What is the guaranteed first-response time SLA for Enterprise merchants?',
      desc: 'Tests factual lookup in DOC-SUP-003',
    },
  ];

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Sidebar Controls */}
      <aside className="w-80 border-r border-slate-800 bg-slate-900/60 p-5 flex flex-col justify-between hidden md:flex">
        <div className="space-y-6">
          <div className="flex items-center space-x-2.5">
            <div className="h-9 w-9 rounded-lg bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-white flex items-center gap-1.5">
                Grounded <span className="text-xs bg-sky-500/20 text-sky-300 font-mono px-1.5 py-0.5 rounded">RAG</span>
              </h1>
              <p className="text-xs text-slate-400">ApexPay Document Intelligence</p>
            </div>
          </div>

          {/* Configuration Form */}
          <div className="space-y-4 pt-2 border-t border-slate-800/80">
            <div className="flex items-center text-xs font-semibold text-slate-300 tracking-wider uppercase">
              <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5 text-sky-400" />
              Retrieval Parameters
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1.5 font-medium">Chunking Strategy</label>
              <select
                value={strategy}
                onChange={e => setStrategy(e.target.value as any)}
                className="w-full bg-slate-800/90 border border-slate-700/80 rounded-md text-xs p-2 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
              >
                <option value="structure_aware">Structure-Aware (Section/Header)</option>
                <option value="fixed">Fixed-Size Window (600c/100o)</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1.5 font-medium">Top-K Retrieved Chunks</label>
              <div className="flex items-center gap-2">
                {[3, 5, 8].map(k => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setTopK(k)}
                    className={`flex-1 py-1.5 rounded text-xs font-mono border transition ${
                      topK === k
                        ? 'bg-sky-500/20 border-sky-500 text-sky-300'
                        : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    k = {k}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1.5 font-medium">Department Filter</label>
              <select
                value={department}
                onChange={e => setDepartment(e.target.value)}
                className="w-full bg-slate-800/90 border border-slate-700/80 rounded-md text-xs p-2 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
              >
                <option value="">All Departments (220 Docs)</option>
                <option value="Customer Support">Customer Support</option>
                <option value="Accounts & KYC">Accounts & KYC</option>
                <option value="Payments & Settlements">Payments & Settlements</option>
                <option value="Merchant Operations">Merchant Operations</option>
                <option value="Security & Compliance">Security & Compliance</option>
                <option value="Product Operations">Product Operations</option>
                <option value="Legal & Governance">Legal & Governance</option>
                <option value="People Operations">People Operations</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1.5 font-medium">Policy Lifecycle Status</label>
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value as any)}
                className="w-full bg-slate-800/90 border border-slate-700/80 rounded-md text-xs p-2 text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
              >
                <option value="active">Active Only (Default)</option>
                <option value="all">Active & Deprecated (History)</option>
                <option value="deprecated">Deprecated Only</option>
              </select>
            </div>
          </div>

          {/* Preset Invariant Queries */}
          <div className="space-y-2 pt-2 border-t border-slate-800/80">
            <div className="text-xs font-semibold text-slate-300 tracking-wider uppercase mb-2">
              Verification Test Bench
            </div>
            {samplePrompts.map((p, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleSubmit(p.prompt)}
                disabled={isLoading}
                className="w-full text-left p-2 rounded-lg bg-slate-800/40 hover:bg-slate-800 border border-slate-700/50 transition group"
              >
                <div className="text-xs font-medium text-slate-200 group-hover:text-sky-300 flex items-center justify-between">
                  {p.label}
                  <ChevronRight className="h-3 w-3 text-slate-500 group-hover:text-sky-400" />
                </div>
                <div className="text-[11px] text-slate-400 truncate mt-0.5">{p.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* System Stats Footer */}
        <div className="pt-4 border-t border-slate-800 text-[11px] text-slate-400 space-y-1">
          <div className="flex justify-between">
            <span>Corpus:</span>
            <span className="text-slate-300 font-mono">220 Docs (1,515 Chunks)</span>
          </div>
          <div className="flex justify-between">
            <span>Embeddings:</span>
            <span className="text-slate-300 font-mono">all-MiniLM-L6-v2 (384d)</span>
          </div>
          <div className="flex justify-between">
            <span>Refusal Gate:</span>
            <span className="text-emerald-400 font-mono">τ = 0.47 (Calibrated)</span>
          </div>
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="flex-1 flex flex-col h-full bg-slate-950 relative">
        {/* Top Navbar */}
        <header className="h-14 border-b border-slate-800 px-6 flex items-center justify-between bg-slate-900/40 backdrop-blur">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span className="text-xs text-slate-300 font-medium">ApexPay Secure Knowledge Base</span>
            <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded border border-slate-700">
              v1.0-verified
            </span>
          </div>
          <div className="text-xs text-slate-400 flex items-center gap-3">
            <span className="hidden sm:inline">Rate Limit: 30 req/min</span>
            <span className="text-slate-600">|</span>
            <a 
              href="/api/logs" 
              target="_blank" 
              rel="noreferrer"
              className="text-sky-400 hover:text-sky-300 flex items-center gap-1"
            >
              Query Logs <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </header>

        {/* Message Thread */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {messages.map(msg => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-3xl rounded-xl p-4 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-sky-600 text-white shadow-md'
                    : msg.refused
                    ? 'bg-amber-950/40 border border-amber-800/60 text-amber-200'
                    : 'bg-slate-900 border border-slate-800 text-slate-200 shadow-sm'
                }`}
              >
                {/* Refusal Banner if Refused */}
                {msg.refused && (
                  <div className="flex items-center gap-2 text-xs font-semibold text-amber-300 mb-2 pb-2 border-b border-amber-800/40">
                    <AlertTriangle className="h-4 w-4 text-amber-400" />
                    <span>Calibrated Evidence Refusal Gate Triggered</span>
                    {msg.topSimilarity !== undefined && msg.threshold !== undefined && (
                      <span className="ml-auto font-mono text-[11px] text-amber-400/80">
                        Score {msg.topSimilarity.toFixed(3)} &lt; τ {msg.threshold.toFixed(2)}
                      </span>
                    )}
                  </div>
                )}

                {/* Message Body */}
                <div className="whitespace-pre-wrap">{msg.content}</div>

                {/* Citations Section */}
                {msg.citations && msg.citations.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-slate-800/80">
                    <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <FileText className="h-3 w-3 text-sky-400" />
                      Verifiable Source Citations ({msg.citations.length})
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {msg.citations.map((c, i) => {
                        const matchingChunk = msg.retrievedChunks?.find(ch => ch.document_id === c.doc_id);
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => matchingChunk && setActiveChunk(matchingChunk)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-slate-800/90 hover:bg-slate-750 border border-slate-700/80 text-xs text-sky-300 hover:text-sky-200 transition font-mono group"
                          >
                            <span>[{c.doc_id}]</span>
                            <span className="text-[10px] text-slate-400 group-hover:text-slate-300">
                              {(c.similarity * 100).toFixed(1)}% match
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Performance & Token Metrics */}
                {msg.metrics && (
                  <div className="mt-3 pt-2 text-[11px] text-slate-400 flex flex-wrap items-center gap-3 border-t border-slate-800/40">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3 text-slate-400" />
                      {msg.metrics.latencyMs}ms
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <Cpu className="h-3 w-3 text-slate-400" />
                      {msg.metrics.promptTokens + msg.metrics.completionTokens} tokens
                    </span>
                    <span>•</span>
                    <span>Cost: ${msg.metrics.estimatedCostUsd.toFixed(5)}</span>
                  </div>
                )}
              </div>

              <span className="text-[10px] text-slate-400 mt-1 px-1">{msg.timestamp}</span>
            </div>
          ))}

          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-slate-400 p-2">
              <span className="h-2 w-2 rounded-full bg-sky-400 animate-ping"></span>
              <span>Retrieving vector embeddings & verifying citations...</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <div className="p-4 border-t border-slate-800 bg-slate-900/60 backdrop-blur">
          <form
            onSubmit={e => {
              e.preventDefault();
              handleSubmit();
            }}
            className="flex items-center gap-2 max-w-4xl mx-auto"
          >
            <input
              type="text"
              value={inputQuery}
              onChange={e => setInputQuery(e.target.value)}
              placeholder="Ask a question about ApexPay policies, limits, refunds, or SLA guarantees..."
              disabled={isLoading}
              className="flex-1 bg-slate-900 border border-slate-700/80 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500 transition"
            />
            <button
              type="submit"
              disabled={isLoading || !inputQuery.trim()}
              className="h-11 px-5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-medium text-sm flex items-center gap-1.5 transition shadow-sm"
            >
              <Send className="h-4 w-4" />
              <span>Ask</span>
            </button>
          </form>
        </div>
      </main>

      {/* Chunk Inspector Drawer */}
      {activeChunk && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-lg bg-slate-900 border-l border-slate-800 h-full p-6 flex flex-col justify-between overflow-y-auto animate-in slide-in-from-right duration-200">
            <div className="space-y-5">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-sky-400" />
                  <h3 className="font-bold text-slate-100">Original Chunk Inspector</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveChunk(null)}
                  className="p-1 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Document Metadata Badges */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="p-2.5 rounded bg-slate-800/60 border border-slate-750">
                  <div className="text-[10px] text-slate-400 uppercase font-semibold">Document ID</div>
                  <div className="font-mono font-bold text-sky-400 text-sm mt-0.5">{activeChunk.document_id}</div>
                </div>
                <div className="p-2.5 rounded bg-slate-800/60 border border-slate-750">
                  <div className="text-[10px] text-slate-400 uppercase font-semibold">Policy Status</div>
                  <div className="mt-0.5">
                    <span className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                      activeChunk.doc_status === 'active'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    }`}>
                      {activeChunk.doc_status.toUpperCase()}
                    </span>
                  </div>
                </div>
                <div className="p-2.5 rounded bg-slate-800/60 border border-slate-750">
                  <div className="text-[10px] text-slate-400 uppercase font-semibold">Department</div>
                  <div className="text-slate-200 truncate mt-0.5">{activeChunk.doc_department}</div>
                </div>
                <div className="p-2.5 rounded bg-slate-800/60 border border-slate-750">
                  <div className="text-[10px] text-slate-400 uppercase font-semibold">Cosine Similarity</div>
                  <div className="font-mono text-emerald-400 font-bold mt-0.5">
                    {(activeChunk.similarity * 100).toFixed(2)}%
                  </div>
                </div>
              </div>

              {/* Supersedes info if present */}
              {activeChunk.doc_supersedes && (
                <div className="p-2 rounded bg-amber-950/30 border border-amber-800/40 text-xs text-amber-300 flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
                  <span>This active document strictly supersedes <strong>{activeChunk.doc_supersedes}</strong></span>
                </div>
              )}

              {/* Section Header */}
              <div>
                <div className="text-xs text-slate-400 uppercase font-semibold mb-1">Target Section</div>
                <div className="text-sm font-semibold text-slate-200">
                  {activeChunk.section_title || 'General'}
                </div>
              </div>

              {/* Raw Chunk Content */}
              <div>
                <div className="text-xs text-slate-400 uppercase font-semibold mb-2">Original Extracted Text</div>
                <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 leading-relaxed whitespace-pre-wrap selection:bg-sky-500/30">
                  {activeChunk.content}
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-800 flex justify-between items-center text-xs text-slate-400">
              <span>Strategy: {activeChunk.strategy}</span>
              <button
                type="button"
                onClick={() => setActiveChunk(null)}
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition"
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
