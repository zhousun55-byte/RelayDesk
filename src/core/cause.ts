import { untilText } from './quota';

/**
 * 结果的说法：群聊、投票、干活、全自动、验收说「成了」「没成」「为什么」都用这里的词。
 * 规则（docs/设计说明.md「结果怎么说」）：一句话，主语在前，原因跟在全角冒号后面；只写事实，不写建议和下一步；不加句号。
 */

/** 「3 分钟」「40 秒」。 */
export function span(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

/** 别处来的一句话（报错、工具原话）：去掉首尾空白和句末的句号。 */
export function plain(text: string): string {
  return text.trim().replace(/[。.]+$/, '');
}

/** 连不上服务器的说法：超时、连接被断、域名解析不了、加密握手失败、工具自己在反复重连。 */
const OFFLINE =
  /request timed out|connect(?:ion)? ?timed? ?out|UND_ERR_CONNECT_TIMEOUT|error sending request|Reconnecting\.\.\.|routing discovery failed|socket disconnected|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|fetch failed|TLS connection|tls handshake|SSL_ERROR|dns error|network error|stream disconnected|connection (?:reset|closed|error|refused)/i;

export function looksOffline(text: string): boolean {
  return OFFLINE.test(text);
}

/** 没成的原因。 */
export const cause = {
  idle: (ms: number) => `${span(ms)}没有输出，已停止`,
  overtime: (ms: number) => `超过 ${span(ms)}，已停止`,
  quota: (until?: string | null) => {
    const t = until ? untilText(until) : '';
    return t ? `额度用完，${t}` : '额度用完';
  },
  denied: (what: string) => `「${what}」没获准运行`,
  silent: (code?: number) => `没有输出${code === undefined ? '' : `（退出码 ${code}）`}`,
  /** 工具出错退出：它说的是连接类的错，就说「连不上服务器」（退出码没有用）。 */
  exit: (code: number, said = '') => `${looksOffline(said) ? '连不上服务器' : `退出码 ${code}`}${plain(said) ? `，原话：${plain(said)}` : ''}`,
  rawToolCall: '回的是调用工具的原文',
};
