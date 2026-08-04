import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLLMProvider } from './factory.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAIProvider } from './openai-provider.js';

describe('LLM factory', () => {
  it('returns undefined when provider is omitted or none', () => {
    assert.equal(createLLMProvider(undefined), undefined);
    assert.equal(createLLMProvider({ provider: 'none' }), undefined);
  });

  it('creates an Ollama provider', () => {
    const provider = createLLMProvider({ provider: 'ollama', model: 'qwen2.5' });
    assert.ok(provider instanceof OllamaProvider);
    assert.equal(provider?.name, 'ollama');
  });

  it('creates an OpenAI provider when an API key is present', () => {
    const provider = createLLMProvider({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o-mini' });
    assert.ok(provider instanceof OpenAIProvider);
    assert.equal(provider?.name, 'openai');
  });

  it('throws for an OpenAI provider without an API key', () => {
    assert.throws(() => createLLMProvider({ provider: 'openai' }), /requires an API key/);
  });

  it('throws for an unknown provider', () => {
    assert.throws(() => createLLMProvider({ provider: 'unknown' as 'ollama' }), /Unknown LLM provider/);
  });
});
