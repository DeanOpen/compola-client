// Message search / RAG index (src-tauri/src/automation/search.rs): keyword (accent-insensitive FTS5) + optional
// semantic search through an embeddings provider (local Ollama or an OpenAI-compatible API).

import { backend } from './backend';
import type { MirrorMessage } from './automation';

export interface SearchConfig {
  enabled: boolean;
  semantic: boolean;
  provider: 'ollama' | 'openai';
  url: string;
  model: string;
  apiKey: string;
}

export interface SearchStats {
  messages: number;
  conversations: number;
  embedded: number;
  embedModel: string;
  oldest: number | null;
  newest: number | null;
  bytes: number;
}

export interface SearchStatus {
  config: SearchConfig;
  stats: SearchStats | null;
  embedError: string | null;
  path: string;
}

export interface SearchHit extends MirrorMessage {
  score: number;
  matched: 'keyword' | 'semantic' | 'both';
  context?: MirrorMessage[];
}

export interface SearchResult {
  mode: 'hybrid' | 'keyword';
  hits: SearchHit[];
  semanticError: string | null;
}

const call = async <T>(command: string, args?: Record<string, unknown>) => (await backend()).invoke<T>(command, args);

export const messageSearch = {
  search: (query: string, opts: { conversationId?: string | null; limit?: number; context?: number } = {}) =>
    call<SearchResult>('automation_search', { query, conversationId: opts.conversationId ?? null, limit: opts.limit ?? 30, context: opts.context ?? 0 }),
  status: () => call<SearchStatus>('automation_search_status'),
  setConfig: (config: SearchConfig) => call<void>('automation_search_set_config', { config }),
  clear: () => call<void>('automation_search_clear'),
  /** Embeds a sample with `config` → vector size. */
  test: (config: SearchConfig) => call<number>('automation_search_test', { config }),
};

/** Suggested embedding models per provider (multilingual: Vietnamese works). */
export const embeddingPresets: Record<SearchConfig['provider'], { url: string; model: string; note: string }> = {
  ollama: { url: 'http://127.0.0.1:11434', model: 'bge-m3', note: 'Chạy trên máy, miễn phí: cài Ollama rồi chạy “ollama pull bge-m3”.' },
  openai: { url: 'https://api.openai.com/v1', model: 'text-embedding-3-small', note: 'Mọi API tương thích OpenAI (OpenAI, Voyage, Jina, LM Studio…). Nội dung tin nhắn được gửi tới nhà cung cấp này.' },
};
