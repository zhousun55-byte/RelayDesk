/** OpenAI 兼容 /chat/completions 客户端（原生 fetch，无第三方依赖）。 */
export interface ChatOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  system: string;
  user: string;
  timeoutMs?: number;
}

export async function chat(o: ChatOptions): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 60_000);
  try {
    const res = await fetch(`${o.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify({
        model: o.model,
        messages: [
          { role: 'system', content: o.system },
          { role: 'user', content: o.user },
        ],
        temperature: 0.2,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content === '') {
      throw new Error('响应缺少 choices[0].message.content');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}
