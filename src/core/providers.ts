import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envValue, userEnvNames } from './env';
import { errorMessage, RelayError } from './errors';
import { listModels, mimocodeConfigPath, readJsonc } from './llm';
import type { ApiSpec } from './types';

/**
 * 模型接口（LLM）的自动识别：扫用户配置的密钥 → 对上接口地址 → 列出能用的模型（不花钱）。
 * 另外会发现别的工具配置里登记过的接口（小米 MiMo 的 Token Plan、Codex 里自定义的接口），
 * 其中要用到别的工具保存的密钥的，必须用户同意后才启用。
 */

export interface ProviderSpec {
  id: string;
  label: string;
  keyEnvs: string[];
  baseUrl: string;
  baseUrlEnvs?: string[];
  format: 'openai' | 'anthropic';
  /** 默认模型的偏好（按顺序匹配列表里的模型名前缀）。 */
  prefer: string[];
  /** 本机服务，不要密钥。 */
  local?: boolean;
}

export const PROVIDERS: ProviderSpec[] = [
  { id: 'deepseek', label: 'DeepSeek', keyEnvs: ['DEEPSEEK_API_KEY'], baseUrl: 'https://api.deepseek.com', format: 'openai', prefer: ['deepseek-chat', 'deepseek-v', 'deepseek'] },
  { id: 'openai', label: 'OpenAI', keyEnvs: ['OPENAI_API_KEY'], baseUrlEnvs: ['OPENAI_BASE_URL', 'OPENAI_API_BASE'], baseUrl: 'https://api.openai.com/v1', format: 'openai', prefer: ['gpt-5-mini', 'gpt-5', 'gpt-4.1', 'gpt-4o'] },
  { id: 'anthropic', label: 'Anthropic', keyEnvs: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], baseUrlEnvs: ['ANTHROPIC_BASE_URL'], baseUrl: 'https://api.anthropic.com', format: 'anthropic', prefer: ['claude-sonnet', 'claude-opus', 'claude'] },
  { id: 'gemini', label: 'Google Gemini', keyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', format: 'openai', prefer: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini'] },
  { id: 'moonshot', label: 'Kimi（月之暗面）', keyEnvs: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'], baseUrl: 'https://api.moonshot.cn/v1', format: 'openai', prefer: ['kimi-k2', 'kimi', 'moonshot'] },
  { id: 'qwen', label: '通义千问', keyEnvs: ['DASHSCOPE_API_KEY'], baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', format: 'openai', prefer: ['qwen3-coder-plus', 'qwen-plus', 'qwen-max', 'qwen'] },
  { id: 'zhipu', label: '智谱 GLM', keyEnvs: ['ZHIPUAI_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY', 'GLM_API_KEY'], baseUrl: 'https://open.bigmodel.cn/api/paas/v4', format: 'openai', prefer: ['glm-5', 'glm-4.6', 'glm-4.5', 'glm'] },
  { id: 'zai', label: 'Z.ai GLM', keyEnvs: ['ZAI_API_KEY'], baseUrl: 'https://api.z.ai/api/paas/v4', format: 'openai', prefer: ['glm-5', 'glm-4.6', 'glm'] },
  { id: 'mimo', label: '小米 MiMo', keyEnvs: ['XIAOMI_API_KEY', 'MIMO_API_KEY'], baseUrlEnvs: ['MIMO_BASE_URL'], baseUrl: 'https://api.xiaomimimo.com/v1', format: 'openai', prefer: ['mimo-v2.6-pro', 'mimo-v2.5-pro', 'mimo'] },
  { id: 'minimax', label: 'MiniMax', keyEnvs: ['MINIMAX_API_KEY'], baseUrl: 'https://api.minimaxi.com/v1', format: 'openai', prefer: ['MiniMax-M2', 'MiniMax'] },
  { id: 'openrouter', label: 'OpenRouter', keyEnvs: ['OPENROUTER_API_KEY'], baseUrl: 'https://openrouter.ai/api/v1', format: 'openai', prefer: ['deepseek/deepseek-chat', 'anthropic/claude-sonnet', 'openai/gpt-5'] },
  { id: 'siliconflow', label: '硅基流动', keyEnvs: ['SILICONFLOW_API_KEY'], baseUrl: 'https://api.siliconflow.cn/v1', format: 'openai', prefer: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-Coder'] },
  { id: 'xai', label: 'xAI Grok', keyEnvs: ['XAI_API_KEY'], baseUrl: 'https://api.x.ai/v1', format: 'openai', prefer: ['grok-4', 'grok-code-fast', 'grok'] },
  { id: 'groq', label: 'Groq', keyEnvs: ['GROQ_API_KEY'], baseUrl: 'https://api.groq.com/openai/v1', format: 'openai', prefer: ['moonshotai/kimi', 'llama'] },
  { id: 'mistral', label: 'Mistral', keyEnvs: ['MISTRAL_API_KEY'], baseUrl: 'https://api.mistral.ai/v1', format: 'openai', prefer: ['codestral', 'mistral-large'] },
  { id: 'volcengine', label: '火山方舟（豆包）', keyEnvs: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'], baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', format: 'openai', prefer: ['doubao-seed', 'doubao'] },
  { id: 'ollama', label: 'Ollama（本机）', keyEnvs: [], baseUrl: 'http://127.0.0.1:11434/v1', format: 'openai', prefer: ['qwen', 'deepseek', 'llama'], local: true },
  { id: 'lmstudio', label: 'LM Studio（本机）', keyEnvs: [], baseUrl: 'http://127.0.0.1:1234/v1', format: 'openai', prefer: [], local: true },
];

/** 小米 MiMo 的几个 Token Plan 接口（models.dev 里的登记；缓存里有就以缓存为准）。 */
const MIMO_BASES: Record<string, string> = {
  xiaomi: 'https://api.xiaomimimo.com/v1',
  'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1',
  'xiaomi-token-plan-sgp': 'https://token-plan-sgp.xiaomimimo.com/v1',
  'xiaomi-token-plan-ams': 'https://token-plan-ams.xiaomimimo.com/v1',
};

/** 不是模型密钥的常见变量。 */
const NOT_LLM = /^(GITHUB_|GH_|NPM_|HF_|HUGGING|CLOUDFLARE|AWS_|AZURE_STORAGE|DOCKER|SENTRY|SLACK|STRIPE|VERCEL|NETLIFY)/;

export interface DetectedProvider {
  id: string;
  label: string;
  format: 'openai' | 'anthropic';
  baseUrl: string;
  /** 密钥在哪个环境变量。 */
  keyEnv?: string;
  /** 密钥在别的工具的配置里（要用户同意）。 */
  keyFrom?: string;
  needsConsent?: boolean;
  models: string[];
  /** 建议用的模型。 */
  model?: string;
  state: 'ok' | 'no' | 'unknown';
  detail: string;
  /** 从哪儿发现的。 */
  source: 'env' | 'local' | 'codex' | 'mimocode';
}

export function pickModel(models: string[], prefer: string[]): string | undefined {
  for (const p of prefer) {
    const exact = models.find((m) => m === p);
    if (exact) return exact;
    const pre = models.find((m) => m.toLowerCase().startsWith(p.toLowerCase()));
    if (pre) return pre;
  }
  return models[0];
}

export function toApiSpec(p: DetectedProvider): ApiSpec {
  return {
    baseUrl: p.baseUrl,
    model: p.model ?? '',
    apiKeyEnv: p.keyEnv ?? '',
    ...(p.format === 'anthropic' ? { format: 'anthropic' as const } : {}),
    ...(p.keyFrom ? { keyFrom: p.keyFrom } : {}),
  };
}

async function probe(p: DetectedProvider, prefer: string[], network: boolean): Promise<DetectedProvider> {
  if (!network) return p;
  try {
    const models = await listModels(toApiSpec({ ...p, model: 'x' }), p.source === 'local' ? 2500 : 8000);
    const chat = models.filter((m) => !/(embed|tts|asr|whisper|image|audio|vision-only|rerank|moderation|dall-e|voice)/i.test(m));
    return { ...p, models: chat.slice(0, 200), model: p.model && chat.includes(p.model) ? p.model : pickModel(chat, prefer) ?? p.model, state: 'ok', detail: `能用（${chat.length} 个模型）` };
  } catch (e) {
    const code = e instanceof RelayError ? e.code : '';
    if (code === 'llm-auth') return { ...p, state: 'no', detail: '密钥被拒绝（可能过期或填错了）' };
    if (p.source === 'local' || /^https?:\/\/(127\.0\.0\.1|localhost)/.test(p.baseUrl)) return { ...p, state: 'no', detail: '本机服务没开（或出错了）' };
    return { ...p, state: 'unknown', detail: `没连上：${errorMessage(e).slice(0, 120)}` };
  }
}

/** Codex 配置里自定义的接口：[model_providers.x] base_url / env_key / name。 */
export function codexProviders(): { id: string; name: string; baseUrl: string; envKey?: string }[] {
  let text = '';
  try {
    text = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  const out: { id: string; name: string; baseUrl: string; envKey?: string }[] = [];
  for (const sec of text.split(/\n(?=\[)/)) {
    const m = sec.match(/^\[model_providers\.([^\]]+)\]/);
    if (!m) continue;
    const get = (k: string) => sec.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
    const baseUrl = get('base_url');
    if (!baseUrl) continue;
    out.push({ id: m[1].replace(/^"|"$/g, ''), name: get('name') ?? m[1], baseUrl, envKey: get('env_key') });
  }
  return out;
}

/** 本机缓存的 models.dev 登记表（MiMo / OpenCode 都会缓存一份），用来查接口地址。 */
function modelsDevBase(id: string): string | undefined {
  for (const f of [path.join(os.homedir(), '.cache', 'mimocode', 'models.json'), path.join(os.homedir(), '.cache', 'opencode', 'models.json')]) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, { api?: string }>;
      if (j[id]?.api) return j[id].api;
    } catch {
      /* 没有缓存 */
    }
  }
  return undefined;
}

/** 小米 MiMo 桌面版（mimocode）里配的接口：只读地址和模型名，不读密钥（用户同意后调用时才读）。 */
export function mimocodeProviders(): DetectedProvider[] {
  const j = readJsonc(mimocodeConfigPath());
  if (!j) return [];
  const out: DetectedProvider[] = [];
  const providers = (j.provider ?? {}) as Record<string, { options?: { apiKey?: unknown; baseURL?: unknown }; models?: Record<string, unknown> }>;
  for (const [id, p] of Object.entries(providers)) {
    const hasKey = typeof p?.options?.apiKey === 'string' && !!p.options.apiKey.trim();
    if (!hasKey) continue;
    const baseUrl = (typeof p.options?.baseURL === 'string' && p.options.baseURL) || modelsDevBase(id) || MIMO_BASES[id];
    if (!baseUrl) continue;
    const models = Object.keys(p.models ?? {});
    const model = pickModel(models, ['mimo-v2.6-pro', 'mimo-v2.5-pro', 'mimo']) ?? 'mimo-v2.6-pro';
    out.push({
      id: `mimocode:${id}`,
      label: `小米 MiMo（MiMo 桌面版里配的 ${/token-plan/.test(id) ? 'Token Plan' : '接口'}）`,
      format: 'openai',
      baseUrl,
      keyFrom: `mimocode:${id}`,
      needsConsent: true,
      models,
      model,
      state: 'unknown',
      detail: '要用 MiMo 桌面版里保存的密钥，你点「同意使用」后才会启用',
      source: 'mimocode',
    });
  }
  return out;
}

export interface ProviderScan {
  providers: DetectedProvider[];
  /** 发现了、但不知道接口地址的密钥变量名。 */
  unknownKeys: string[];
}

/** 扫一遍所有模型接口。network=false 时只看密钥，不连网。 */
export async function scanProviders(opts: { network?: boolean } = {}): Promise<ProviderScan> {
  const network = opts.network !== false;
  const claimed = new Set<string>();
  const jobs: Promise<DetectedProvider>[] = [];
  for (const spec of PROVIDERS) {
    for (const k of spec.keyEnvs) claimed.add(k);
    if (spec.local) {
      if (!network) continue;
      jobs.push(probe({ id: spec.id, label: spec.label, format: spec.format, baseUrl: spec.baseUrl, models: [], state: 'unknown', detail: '', source: 'local' }, spec.prefer, true));
      continue;
    }
    const keyEnv = spec.keyEnvs.find((k) => envValue(k));
    if (!keyEnv) continue;
    const baseEnv = spec.baseUrlEnvs?.find((k) => envValue(k));
    const baseUrl = (baseEnv ? envValue(baseEnv)! : spec.baseUrl).replace(/\/+$/, '');
    const p: DetectedProvider = { id: spec.id, label: spec.label, format: spec.format, baseUrl, keyEnv, models: [], state: 'unknown', detail: network ? '' : '找到密钥（没连网检查）', source: 'env' };
    jobs.push(probe(p, spec.prefer, network));
  }
  for (const cp of codexProviders()) {
    if (!cp.envKey || claimed.has(cp.envKey) || !envValue(cp.envKey)) continue;
    claimed.add(cp.envKey);
    const p: DetectedProvider = { id: `codex:${cp.id}`, label: `${cp.name}（Codex 里配的接口）`, format: 'openai', baseUrl: cp.baseUrl.replace(/\/+$/, ''), keyEnv: cp.envKey, models: [], state: 'unknown', detail: '', source: 'codex' };
    jobs.push(probe(p, [], network));
  }
  const found = await Promise.all(jobs);
  const providers = found.filter((p) => !(p.source === 'local' && p.state !== 'ok'));
  providers.push(...mimocodeProviders());
  const unknownKeys = userEnvNames()
    .filter((k) => /(_API_KEY|_APIKEY|_AUTH_TOKEN)$/.test(k) && !claimed.has(k) && !NOT_LLM.test(k))
    .sort();
  return { providers, unknownKeys };
}
