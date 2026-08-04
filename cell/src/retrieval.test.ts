import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RetrievalEngine } from './retrieval.js';
import type { MemoryDocument } from './types.js';

function doc(id: string, text: string): MemoryDocument {
  return { id, kind: 'progress', text, timestamp: '2026-08-01T00:00:00Z', metadata: {} };
}

describe('RetrievalEngine', () => {
  it('ranks documents by keyword overlap', () => {
    const engine = new RetrievalEngine({ topK: 3 });
    const docs = [
      doc('a', 'the quick brown fox'),
      doc('b', 'timeout retry network failure'),
      doc('c', 'brown fox jumps over the lazy dog'),
    ];
    const results = engine.retrieve('timeout failure', docs);
    assert.equal(results[0].document.id, 'b');
    assert.ok(results[0].score > 0);
  });

  it('returns empty results for an empty query', () => {
    const engine = new RetrievalEngine();
    assert.deepEqual(engine.retrieve('', [doc('a', 'hello')]), []);
  });

  it('formats context from results', () => {
    const engine = new RetrievalEngine();
    const results = engine.retrieve('timeout', [doc('b', 'timeout retry network failure')]);
    const context = engine.formatContext(results);
    assert.match(context, /progress:b/);
    assert.match(context, /timeout retry network failure/);
  });
});
