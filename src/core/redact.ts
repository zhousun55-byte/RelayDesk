/**
 * 送去外部模型之前抹掉密钥。快照和给复核准备的改动留在本机，不抹；
 * 出网的材料（群聊、投票、内置小代理读到的文件和命令输出）和脱敏导出换成 [REDACTED]。
 */

export const REDACTED = '[REDACTED]';

/** 值本身有固定样子的密钥：私钥、sk-…、ghp_…、AWS、Slack。 */
const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

/** 名字说明它是密钥的赋值：api_key = …、"token": "…"。 */
const ASSIGNED: RegExp[] = [
  /\b(api[_-]?key|secret|token|access[_-]?token|password)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/i,
  /"(?:api[_-]?key|apiKey|secret|token|access[_-]?token|password)"\s*:\s*"[^"]+"/i,
];

const ALL = [...SHAPES, ...ASSIGNED].map((re) => new RegExp(re.source, `${re.flags}g`));

export function redactSecrets(text: string): string {
  return ALL.reduce((out, re) => out.replace(re, REDACTED), text);
}

/** 一个值本身像不像密钥（给环境变量用：名字看不出来的，看值）。 */
export function looksSecret(value: string): boolean {
  return SHAPES.some((re) => re.test(value));
}
