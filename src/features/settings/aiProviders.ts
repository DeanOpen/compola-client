// AI services for add-ons (Settings › Add-on › AI). Each one is either the Claude API or an OpenAI-compatible
// `/chat/completions` server: picking it fills the server address, a starting model and where to get a key. The model
// field then lists what the service really offers with that key (`addons_ai_models`). Starting models checked against the
// providers' docs and OpenRouter's catalogue on 2026-11-25 (Meta's Llama API has nothing newer than Llama 4; Mistral's
// `-latest` alias always follows its newest Large).

import type { AiConfig } from '../../engine/addons';

export interface AiProvider {
  id: string;
  name: string;
  /** One line under the name. */
  note: string;
  protocol: 'anthropic' | 'openai';
  /** Server address; empty for Claude (its default) and "Tuỳ chỉnh". */
  url: string;
  /** Starting model (the live list replaces the guess once a key is in). */
  model: string;
  /** Where to create a key; null when none is needed. */
  keyUrl: string | null;
  keyPlaceholder: string;
  /** A key is optional (local servers). */
  keyOptional?: boolean;
}

export const aiProviders: AiProvider[] = [
  { id: 'anthropic', name: 'Claude', note: 'Anthropic', protocol: 'anthropic', url: '', model: 'claude-sonnet-5-5', keyUrl: 'https://console.anthropic.com/settings/keys', keyPlaceholder: 'sk-ant-…' },
  { id: 'openai', name: 'OpenAI', note: 'GPT', protocol: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-6.2-sol', keyUrl: 'https://platform.openai.com/api-keys', keyPlaceholder: 'sk-…' },
  { id: 'openrouter', name: 'OpenRouter', note: 'Mọi model, một khoá', protocol: 'openai', url: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', keyUrl: 'https://openrouter.ai/keys', keyPlaceholder: 'sk-or-…' },
  { id: 'gemini', name: 'Gemini', note: 'Google', protocol: 'openai', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-4-hydrogen', keyUrl: 'https://aistudio.google.com/apikey', keyPlaceholder: 'AIza…' },
  { id: 'deepseek', name: 'DeepSeek', note: 'Rẻ, giỏi tiếng Việt', protocol: 'openai', url: 'https://api.deepseek.com', model: 'deepseek-flash', keyUrl: 'https://platform.deepseek.com/api_keys', keyPlaceholder: 'sk-…' },
  { id: 'zai', name: 'Z.ai', note: 'GLM', protocol: 'openai', url: 'https://api.z.ai/api/paas/v4', model: 'glm-5.4', keyUrl: 'https://z.ai/manage-apikey/apikey-list', keyPlaceholder: 'Khoá Z.ai' },
  { id: 'kimi', name: 'Kimi', note: 'Moonshot AI', protocol: 'openai', url: 'https://api.moonshot.ai/v1', model: 'kimi-k3.1-pro', keyUrl: 'https://platform.moonshot.ai/console/api-keys', keyPlaceholder: 'sk-…' },
  { id: 'meta', name: 'Meta Llama', note: 'Llama API', protocol: 'openai', url: 'https://api.llama.com/compat/v1', model: 'Llama-4-Maverick-17B-128E-Instruct-FP8', keyUrl: 'https://llama.developer.meta.com', keyPlaceholder: 'LLM|…' },
  { id: 'qwen', name: 'Qwen', note: 'Alibaba Cloud', protocol: 'openai', url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen4-max', keyUrl: 'https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key', keyPlaceholder: 'sk-…' },
  { id: 'xai', name: 'xAI', note: 'Grok', protocol: 'openai', url: 'https://api.x.ai/v1', model: 'grok-4.7', keyUrl: 'https://console.x.ai', keyPlaceholder: 'xai-…' },
  { id: 'groq', name: 'Groq', note: 'Trả lời rất nhanh', protocol: 'openai', url: 'https://api.groq.com/openai/v1', model: 'qwen/qwen3.8-27b', keyUrl: 'https://console.groq.com/keys', keyPlaceholder: 'gsk_…' },
  { id: 'mistral', name: 'Mistral', note: 'Mistral AI', protocol: 'openai', url: 'https://api.mistral.ai/v1', model: 'mistral-large-latest', keyUrl: 'https://console.mistral.ai/api-keys', keyPlaceholder: 'Khoá Mistral' },
  { id: 'ollama', name: 'Ollama', note: 'Chạy trên máy', protocol: 'openai', url: 'http://127.0.0.1:11434/v1', model: 'inkling-2-mini', keyUrl: null, keyPlaceholder: 'không cần', keyOptional: true },
  { id: 'custom', name: 'Tuỳ chỉnh', note: 'API tương thích OpenAI', protocol: 'openai', url: '', model: '', keyUrl: null, keyPlaceholder: 'nếu máy chủ cần', keyOptional: true },
];

export const claudeModels = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

const byId = new Map(aiProviders.map((p) => [p.id, p]));
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** The service a saved config belongs to (configs saved before services existed have no usable `preset`). */
export const providerOf = (c: Pick<AiConfig, 'provider' | 'preset' | 'url'>): AiProvider => {
  const saved = c.preset ? byId.get(c.preset) : undefined;
  if (saved && saved.protocol === c.provider) return saved;
  if (c.provider === 'anthropic') return byId.get('anthropic')!;
  const host = hostOf(c.url.trim() || 'http://127.0.0.1:11434/v1');
  return aiProviders.find((p) => p.protocol === 'openai' && p.url && hostOf(p.url) === host) ?? byId.get('custom')!;
};

/** The config for another service: its protocol, address and starting model (the key is never carried over). */
export const switchProvider = (c: AiConfig, p: AiProvider): AiConfig => ({
  ...c,
  preset: p.id,
  provider: p.protocol,
  url: p.url,
  model: p.model,
  apiKey: '',
});
