import type { LLMMessage, LLMProvider, LLMResponse } from './types.js';

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';

  constructor(private readonly options: OllamaProviderOptions) {}

  async complete(options: {
    messages: LLMMessage[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<LLMResponse> {
    const url = `${this.options.baseUrl}/api/chat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model,
        messages: options.messages,
        stream: false,
        options: {
          temperature: options.temperature ?? this.options.temperature ?? 0.7,
          num_predict: options.maxTokens ?? this.options.maxTokens ?? 512,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      text: data.message?.content ?? '',
      usage: {
        promptTokens: data.prompt_eval_count,
        completionTokens: data.eval_count,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
    };
  }
}
