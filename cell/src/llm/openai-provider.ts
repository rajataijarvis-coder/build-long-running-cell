import type { LLMMessage, LLMProvider, LLMResponse } from './types.js';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  constructor(private readonly options: OpenAIProviderOptions) {}

  async complete(options: {
    messages: LLMMessage[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<LLMResponse> {
    const url = `${this.options.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: options.messages,
        temperature: options.temperature ?? this.options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? this.options.maxTokens ?? 512,
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: LLMResponse['usage'];
    };
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      usage: data.usage,
    };
  }
}
