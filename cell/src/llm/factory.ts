import type { LLMProvider, LLMProviderConfig } from './types.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAIProvider } from './openai-provider.js';

export function createLLMProvider(
  config?: LLMProviderConfig
): LLMProvider | undefined {
  if (!config || config.provider === 'none' || config.provider === undefined) {
    return undefined;
  }

  if (config.provider === 'ollama') {
    return new OllamaProvider({
      baseUrl: config.baseUrl ?? 'http://localhost:11434',
      model: config.model ?? 'llama3.1',
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
  }

  if (config.provider === 'openai') {
    if (!config.apiKey) {
      throw new Error('OpenAI provider requires an API key');
    }
    return new OpenAIProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model ?? 'gpt-4o-mini',
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
  }

  throw new Error(`Unknown LLM provider: ${config.provider}`);
}

export function createLLMProviderFromEnv(): LLMProvider | undefined {
  const provider = process.env.LLM_PROVIDER;
  if (!provider || provider === 'none') return undefined;

  return createLLMProvider({
    provider,
    baseUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    temperature: process.env.LLM_TEMPERATURE
      ? parseFloat(process.env.LLM_TEMPERATURE)
      : undefined,
    maxTokens: process.env.LLM_MAX_TOKENS
      ? parseInt(process.env.LLM_MAX_TOKENS, 10)
      : undefined,
  });
}
