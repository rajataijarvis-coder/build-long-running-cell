export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface LLMProvider {
  name: string;
  complete(options: { messages: LLMMessage[]; temperature?: number; maxTokens?: number }): Promise<LLMResponse>;
}

export interface LLMProviderConfig {
  provider: 'ollama' | 'openai' | string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}
