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
  exit: (code: number, said = '') => `退出码 ${code}${plain(said) ? `，原话：${plain(said)}` : ''}`,
  rawToolCall: '回的是调用工具的原文',
};
