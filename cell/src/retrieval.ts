import type { MemoryDocument, RetrievalResult } from './types.js';

export interface RetrievalEngineOptions {
  topK?: number;
  minScore?: number;
}

/**
 * A deterministic retrieval engine that scores documents by token overlap.
 *
 * This implementation uses simple keyword matching so the behavior stays
 * testable and cheap to run. The interface is the same one you would use
 * with embeddings later: pass a query and a document collection, receive
 * ranked results and a formatted context string.
 */
export class RetrievalEngine {
  constructor(private readonly options: RetrievalEngineOptions = {}) {}

  retrieve(query: string, documents: MemoryDocument[]): RetrievalResult[] {
    const topK = this.options.topK ?? 5;
    const minScore = this.options.minScore ?? 0.01;
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];

    const scored = documents.map((doc) => ({
      document: doc,
      score: this.score(queryTerms, doc.text),
    }));

    return scored
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  formatContext(results: RetrievalResult[]): string {
    if (results.length === 0) return 'No relevant memory found.';
    return results
      .map((r, i) => `[${i + 1}] ${r.document.kind}:${r.document.id} (score:${r.score.toFixed(3)})\n${r.document.text}`)
      .join('\n---\n');
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }

  private score(queryTerms: string[], text: string): number {
    const docTerms = this.tokenize(text);
    if (docTerms.length === 0) return 0;
    const matches = queryTerms.filter((q) => docTerms.includes(q)).length;
    return matches / Math.sqrt(queryTerms.length * docTerms.length);
  }
}
