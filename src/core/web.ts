import net from 'node:net';

/**
 * 内置小代理上网用的两样：搜网页、读网页。走接口的成员（GLM、MiMo、DeepSeek）自己不会上网，
 * 没有这两样，要查资料的活它只能凭记忆写，还会把「不能联网」写成任务约定，连累后面能联网的成员（2026-09-30 药明康德那次）。
 * 只读不写：只发 GET，不带任何登录信息；不访问本机和局域网的地址。
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MAX_BYTES = 3 << 20;
const TIMEOUT_MS = 20_000;

export class WebError extends Error {}

/** 本机、局域网、链路本地这些地址不让访问（不然网页里的一句话就能让它去读路由器、本机服务）。 */
export function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0') return true;
  const v = net.isIP(h);
  if (v === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
}

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebError(`不是网址：${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new WebError('只能读 http / https 的网页。');
  if (u.username || u.password) throw new WebError('网址里不能带用户名密码。');
  if (privateHost(u.hostname)) throw new WebError('不能访问本机或局域网的地址。');
  return u;
}

/** GET 一个网址（自己跟跳转，每一跳都查地址），返回最终网址、类型和正文。 */
async function get(raw: string, fetcher: typeof fetch = fetch): Promise<{ url: string; type: string; body: string }> {
  let u = checkUrl(raw);
  for (let hop = 0; hop < 6; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetcher(u, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        u = checkUrl(new URL(res.headers.get('location')!, u).toString());
        continue;
      }
      if (!res.ok) throw new WebError(`打不开（HTTP ${res.status}）：${u}`);
      const type = res.headers.get('content-type') ?? '';
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
      return { url: u.toString(), type, body: Buffer.concat(chunks).toString('utf8') };
    } catch (e) {
      if (e instanceof WebError) throw e;
      throw new WebError(ctrl.signal.aborted ? `超时（${TIMEOUT_MS / 1000} 秒）：${u}` : `打不开：${u}（${e instanceof Error ? e.message : String(e)}）`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new WebError('跳转太多次了。');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** 网页转成纯文字：去掉脚本、样式、导航这些，块级标签换行。 */
export function htmlText(html: string): { title: string; text: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg|template|nav|footer|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/table)\b[^>]*>/gi, '\n')
      .replace(/<(td|th)\b[^>]*>/gi, ' | ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

/** 读一个网页：返回标题、最终网址和正文文字（最多 max 字）。 */
export async function fetchPage(url: string, max = 20_000, fetcher?: typeof fetch): Promise<string> {
  const r = await get(url, fetcher);
  const isHtml = /html|xml/i.test(r.type) || /^\s*</.test(r.body);
  if (!isHtml && !/text|json|javascript|csv/i.test(r.type) && r.type) return `${r.url}\n这个网址是 ${r.type}，不是网页文字，没有读。`;
  const { title, text } = isHtml ? htmlText(r.body) : { title: '', text: r.body.trim() };
  const cut = text.length > max ? `${text.slice(0, max)}\n…（正文共 ${text.length} 字，只给了前 ${max} 字）` : text;
  return `${title ? `${title}\n` : ''}${r.url}\n\n${cut || '（没有正文）'}`;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function clean(s: string): string {
  return decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** DuckDuckGo 的网页版结果。 */
export function parseDuck(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="result__a"|$)/g;
  for (const m of html.matchAll(re)) {
    let url = decode(m[1]);
    const real = url.match(/[?&]uddg=([^&]+)/);
    if (real) url = decodeURIComponent(real[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // 广告
    const snippet = m[3].match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
    out.push({ title: clean(m[2]), url, snippet: clean(snippet) });
  }
  return out;
}

/** 必应的结果。 */
export function parseBing(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const block of html.split(/<li class="b_algo"/).slice(1)) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
    out.push({ title: clean(a[2]), url: decode(a[1]), snippet: clean(snippet) });
  }
  return out;
}

/** 搜网页：先问 DuckDuckGo，搜不到或打不开再问必应。 */
export async function webSearch(query: string, n = 8, fetcher?: typeof fetch): Promise<string> {
  const q = query.trim();
  if (!q) throw new WebError('搜什么？query 是空的。');
  const tries: [string, (h: string) => SearchHit[]][] = [
    [`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parseDuck],
    [`https://cn.bing.com/search?q=${encodeURIComponent(q)}`, parseBing],
  ];
  const errors: string[] = [];
  for (const [url, parse] of tries) {
    try {
      const hits = parse((await get(url, fetcher)).body).filter((h) => h.url.startsWith('http')).slice(0, n);
      if (hits.length) return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`).join('\n');
      errors.push(`${new URL(url).hostname} 没搜到`);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new WebError(`没搜到结果（${errors.join('；')}）。换个说法再搜，或者直接用 fetch_url 读知道的网址。`);
}
