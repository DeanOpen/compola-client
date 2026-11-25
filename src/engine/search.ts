// Message search / RAG index (src-tauri/src/automation/search.rs): keyword (accent-insensitive FTS5) + optional
// semantic search through an embeddings provider: built in (multilingual-e5-small run by Compola, one-click download),
// a local Ollama, or an OpenAI-compatible API.

import { backend } from './backend';
import type { MirrorMessage } from './automation';

export interface SearchConfig {
  enabled: boolean;
  semantic: boolean;
  provider: 'builtin' | 'ollama' | 'openai';
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
  /** `ollama pull <model>` through the local Ollama (minutes for a large model). */
  pullModel: (config: SearchConfig) => call<void>('automation_search_pull_model', { config }),
  /** The built-in model (src-tauri/src/automation/embedder.rs): installed, download progress. */
  builtinStatus: () => call<BuiltinStatus>('automation_search_builtin_status'),
  /** Downloads it (~490 MB, once); resolves when done. */
  builtinInstall: () => call<void>('automation_search_builtin_install'),
  builtinRemove: () => call<void>('automation_search_builtin_remove'),
};

export interface BuiltinStatus {
  model: string;
  installed: boolean;
  downloading: boolean;
  received: number;
  total: number;
  error: string | null;
}

/** Suggested embedding models per provider (multilingual: Vietnamese works). */
export const embeddingPresets: Record<SearchConfig['provider'], { url: string; model: string; note: string }> = {
  builtin: { url: '', model: 'multilingual-e5-small', note: 'Compola tự chạy mô hình trên máy này: không cần cài gì, tin nhắn không rời máy. Tải một lần khoảng 490 MB.' },
  ollama: { url: 'http://127.0.0.1:11434', model: 'bge-m3', note: 'Chạy trên máy, miễn phí, tin nhắn không rời máy này. Cần cài Ollama; Compola tự tải model khi kiểm tra.' },
  openai: { url: 'https://api.openai.com/v1', model: 'text-embedding-3-small', note: 'Mọi API tương thích OpenAI (OpenAI, Voyage, Jina, LM Studio…). Nội dung tin nhắn được gửi tới nhà cung cấp này.' },
};

/** What an embeddings error asks of the user (search.rs `OLLAMA_MISSING` / `OLLAMA_MODEL`), and its text. */
export const embedProblem = (e: string): { kind: 'ollama-missing' | 'ollama-model' | 'builtin-missing' | null; text: string } => {
  const m = /^\[(ollama-missing|ollama-model|builtin-missing)\]\s*/.exec(e);
  return m ? { kind: m[1] as 'ollama-missing' | 'ollama-model' | 'builtin-missing', text: e.slice(m[0].length) } : { kind: null, text: e };
};
