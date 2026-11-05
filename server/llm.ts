import type { AiProvider, AiProviderId, AiSettings } from '../shared/types.ts';

/* ------------------------------ 厂商预设 ------------------------------ */

export const PROVIDERS: (AiProvider & { models: { text: string[]; vision: string[] } })[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    textModel: 'deepseek-flash',
    visionModel: 'deepseek-flash',
    supportsVision: true,
    supportsJsonMode: true,
    keyHint: 'sk-…',
    docs: 'https://api-docs.deepseek.com/zh-cn/guides/vision',
    // deepseek-flash = V4.1 Flash（原生多模态，文本/视觉同一个 id）
    models: {
      text: ['deepseek-flash', 'deepseek-reasoner'],
      vision: ['deepseek-flash'],
    },
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    textModel: 'deepseek-v4.1-flash',
    visionModel: 'deepseek-v4.1-flash',
    supportsVision: true,
    supportsJsonMode: true,
    keyHint: 'OpenCode Zen 控制台生成的 key',
    reasoningEffort: 'low',
    docs: 'https://opencode.ai/docs/go/',
    // Zen 要求带上会话头，同一会话的上游保持一致，提示词缓存也更容易命中
    extraHeaders: { 'x-opencode-session': 'paper-ai', 'x-opencode-client': 'paper-ai' },
    models: {
      text: ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'glm-5.3', 'kimi-k3', 'qwen3.8-max', 'minimax-m3'],
      // 这些都支持 image/* 输入
      vision: ['deepseek-v4.1-flash', 'kimi-k3', 'qwen3.8-max', 'gpt-6-luna', 'claude-haiku-5-5'],
    },
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    textModel: 'glm-4-flash',
    visionModel: 'glm-4v-flash',
    supportsVision: true,
    supportsJsonMode: true,
    keyHint: 'xxxx.xxxx',
    docs: 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4v',
    models: {
      text: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
      vision: ['glm-4v-flash', 'glm-4v-plus'],
    },
  },
  {
    id: 'moonshot',
    label: 'Moonshot 月之暗面',
    baseURL: 'https://api.moonshot.cn/v1',
    textModel: 'moonshot-v1-8k',
    visionModel: 'moonshot-v1-8k-vision-preview',
    supportsVision: true,
    supportsJsonMode: true,
    keyHint: 'sk-…',
    docs: 'https://platform.moonshot.cn/docs',
    models: {
      text: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0905-preview'],
      vision: ['moonshot-v1-8k-vision-preview', 'moonshot-v1-32k-vision-preview'],
    },
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    textModel: 'qwen-plus',
    visionModel: 'qwen-vl-max',
    supportsVision: true,
    supportsJsonMode: true,
    keyHint: 'sk-…',
    docs: 'https://help.aliyun.com/zh/model-studio/vision',
    models: {
      text: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
      vision: ['qwen-vl-max', 'qwen-vl-plus'],
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    textModel: 'gpt-4o-mini',
    visionModel: 'gpt-4o-mini',
    supportsVision: true,
    supportsJsonMode: true,
    keyHint: 'sk-…',
    docs: 'https://platform.openai.com/docs/guides/vision',
    models: {
      text: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
      vision: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    },
  },
  {
    id: 'ollama',
    label: 'Ollama（本机）',
    baseURL: 'http://127.0.0.1:11434/v1',
    textModel: 'qwen2.5:7b',
    visionModel: 'qwen2.5vl:7b',
    supportsVision: true,
    supportsJsonMode: true,
    keyHint: '任意字符串，例如 ollama',
    docs: 'https://ollama.com/blog/openai-compatibility',
    models: {
      text: ['qwen2.5:7b', 'qwen3:8b', 'llama3.1:8b'],
      vision: ['qwen2.5vl:7b', 'llava:7b', 'minicpm-v:8b'],
    },
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseURL: '',
    textModel: '',
    visionModel: '',
    supportsVision: true,
    supportsJsonMode: true,
    keyHint: '按服务商要求填写',
    docs: 'https://platform.openai.com/docs/api-reference/chat',
    models: { text: [], vision: [] },
  },
];

export function providerById(id: AiProviderId) {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

/* ------------------------------ 内容与消息 ------------------------------ */

export type TextPart = { type: 'text'; text: string };
export type ImagePart = { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' | 'original' } };
export type ContentPart = TextPart | ImagePart;
export type Msg = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] };

export type ChatOptions = {
  model: string;
  /** 部分厂商（OpenCode Go / DeepSeek 推理模型）需要显式指定思考强度 */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | null;
  messages: Msg[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
};

export type ChatResult = {
  text: string;
  usage?: { prompt: number; completion: number; total: number };
  model: string;
};

export class LlmError extends Error {
  status?: number;
  detail?: string;
  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.detail = detail;
  }
}

/* -------------------------------- 客户端 -------------------------------- */

function joinURL(base: string, suffix: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  return b + suffix;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LlmClient {
  private cfg: AiSettings;
  constructor(cfg: AiSettings) {
    this.cfg = cfg;
  }

  static from(cfg: AiSettings) {
    return new LlmClient(cfg);
  }

  get visionModel(): string {
    return (this.cfg.visionModel || this.cfg.textModel || '').trim();
  }

  get textModel(): string {
    return (this.cfg.textModel || '').trim();
  }

  get hasKey(): boolean {
    return !!this.cfg.apiKey.trim();
  }

  get baseURL(): string {
    return (this.cfg.baseURL || '').trim();
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    if (!this.baseURL) throw new LlmError('尚未配置接口地址（Base URL），请到「设置」中填写');
    if (!this.cfg.apiKey && !/localhost|127\.0\.0\.1/.test(this.baseURL)) {
      throw new LlmError('尚未配置 API Key，请到「设置」中填写');
    }
    const retries = opts.retries ?? 3;
    let lastErr: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.once(opts);
      } catch (err) {
        lastErr = err;
        const e = err as LlmError;
        const retriable =
          e.status === undefined || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
        if (!retriable || attempt === retries) break;
        await sleep(700 * 2 ** attempt + Math.floor(Math.random() * 300));
      }
    }
    throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
  }

  private async once(opts: ChatOptions, escalate = 0): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? this.cfg.temperature ?? 0,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.json && this.cfg.jsonMode) body.response_format = { type: 'json_object' };

    const providerDefaults = PROVIDERS.find((p) => p.id === this.cfg.provider) as
      | { reasoningEffort?: string }
      | undefined;
    const effort = opts.reasoningEffort ?? providerDefaults?.reasoningEffort;
    if (effort) body.reasoning_effort = effort;

    const url = joinURL(this.baseURL, '/chat/completions');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    const provider = providerById(this.cfg.provider);
    for (const [k, v] of Object.entries(provider.extraHeaders ?? {})) headers[k] = v;

    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 180_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new LlmError(`请求超时（${Math.round((opts.timeoutMs ?? 180_000) / 1000)}s），可能是图片过大或网络不稳定`);
      }
      throw new LlmError(`无法连接模型接口：${e.message}。请检查 Base URL、网络与代理设置`);
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let detail = raw;
      try {
        const j = JSON.parse(raw) as { error?: { message?: string }; message?: string };
        detail = j.error?.message ?? j.message ?? raw;
      } catch {
        /* 保留原文 */
      }
      // 部分厂商不支持 response_format，去掉后重试一次
      if (res.status === 400 && opts.json && /response_format|json_object/i.test(detail)) {
        return this.once({ ...opts, json: false }, escalate);
      }
      const friendly =
        res.status === 401
          ? 'API Key 无效或已过期（401），请到设置里重新填写'
          : res.status === 402
            ? '模型账户余额不足（402），请充值或换一个 Key / 服务商'
            : res.status === 403
              ? '没有访问该模型的权限（403），请检查 Key 的套餐与模型名'
              : res.status === 429
                ? '请求太频繁被限流（429），把设置里的并发数调小一点'
                : `模型接口返回 ${res.status}`;
      throw new LlmError(`${friendly}：${String(detail).slice(0, 200)}`, res.status, detail);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
    };
    const choice = data.choices?.[0] as
      | { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }
      | undefined;
    const text = choice?.message?.content ?? '';
    const thinking = String(choice?.message?.reasoning_content ?? '');

    if (!text.trim()) {
      // 推理模型常把 token 全花在思考上，导致 content 为空（finish_reason=length）。
      // 先加预算、压低思考强度重试一次；仍为空就把思考内容里能捞到的 JSON 用起来。
      if (escalate < 1) {
        return this.once(
          {
            ...opts,
            maxTokens: Math.max(4096, (opts.maxTokens ?? 2000) * 2),
            reasoningEffort: 'low',
          },
          escalate + 1,
        );
      }
      if (thinking.trim()) {
        return { text: thinking, model: data.model ?? opts.model };
      }
      throw new LlmError(
        `模型返回了空内容（finish_reason=${choice?.finish_reason ?? '未知'}）。` +
          '多半是思考占满了输出预算，或内容被上游拦截；换一个模型名再试',
      );
    }
    return {
      text,
      model: data.model ?? opts.model,
      usage: data.usage
        ? {
            prompt: data.usage.prompt_tokens ?? 0,
            completion: data.usage.completion_tokens ?? 0,
            total: data.usage.total_tokens ?? 0,
          }
        : undefined,
    };
  }
}

/* ------------------------------ JSON 解析 ------------------------------ */

/** 从模型输出里稳妥地取出 JSON：兼容 ```json 代码块、前后废话、尾随逗号。 */
export function extractJson<T = unknown>(text: string): T | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();

  const start = (() => {
    const a = t.indexOf('{');
    const b = t.indexOf('[');
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  })();
  if (start < 0) return null;

  const open = t[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = t.slice(start, i + 1);
        for (const candidate of [slice, repair(slice)]) {
          try {
            return JSON.parse(candidate) as T;
          } catch {
            /* 尝试下一种 */
          }
        }
      }
    }
  }
  return null;
}

function repair(json: string): string {
  return json
    .replace(/,\s*([}\]])/g, '$1') // 尾随逗号
    .replace(/[\u201c\u201d]/g, '"') // 中文引号
    .replace(/[\u2018\u2019]/g, "'");
}

/* ------------------------------ 模型列表 ------------------------------ */

/** GET {baseURL}/models —— OpenAI 兼容接口都有，用来在填完 Key 后列可用模型 */
export type ModelInfo = { id: string; vision: boolean };

export async function listModels(baseURL: string, apiKey: string): Promise<ModelInfo[]> {
  const base = baseURL.replace(/\/+$/, '');
  if (!base) throw new LlmError('请先填写 Base URL');
  const url = /\/models$/.test(base) ? base : `${base}/models`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new LlmError(`连不上模型列表接口：${(err as Error).message}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const friendly =
      res.status === 401 ? 'API Key 无效（401）' : res.status === 404 ? '该服务商没有 /models 接口' : `返回 ${res.status}`;
    throw new LlmError(`${friendly}：${detail.slice(0, 160)}`, res.status);
  }

  const data = (await res.json().catch(() => null)) as unknown;
  const arr = Array.isArray((data as { data?: unknown })?.data)
    ? ((data as { data: unknown[] }).data as unknown[])
    : Array.isArray(data)
      ? (data as unknown[])
      : [];
  const models: ModelInfo[] = arr
    .map((m) => {
      if (typeof m === 'string') return { id: m, vision: false };
      const o = m as { id?: unknown; name?: unknown; modalities?: { input?: unknown[] } };
      const id = String(o.id ?? o.name ?? '');
      const input = Array.isArray(o.modalities?.input) ? o.modalities!.input! : [];
      const vision = input.some((x) => typeof x === 'string' && (x === 'image' || x.startsWith('image/')));
      return { id, vision };
    })
    .filter((m) => m.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!models.length) throw new LlmError('接口没有返回任何模型');
  return models;
}

/* -------------------------------- 自检 -------------------------------- */

export async function testConnection(cfg: AiSettings): Promise<{ ok: boolean; model: string; ms: number; reply: string }> {
  const client = new LlmClient(cfg);
  const t0 = Date.now();
  const res = await client.chat({
    model: client.textModel,
    messages: [
      { role: 'system', content: '你是一个连通性测试助手。' },
      { role: 'user', content: '只回复两个字：正常' },
    ],
    maxTokens: 20,
    retries: 1,
    timeoutMs: 30_000,
  });
  return { ok: true, model: res.model, ms: Date.now() - t0, reply: res.text.trim().slice(0, 40) };
}
