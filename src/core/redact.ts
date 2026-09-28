/**
 * 送去外部模型之前抹掉密钥。快照和给复核准备的改动留在本机，不抹；
 * 出网的材料（群聊、投票、内置小代理读到的文件和命令输出）换成 [REDACTED]。
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(api[_-]?key|secret|token|access[_-]?token|password)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi,
  /"(?:api[_-]?key|apiKey|secret|token|access[_-]?token|password)"\s*:\s*"[^"]+"/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** 一个值本身像不像密钥（私钥、sk-…、ghp_… 这类有固定样子的）。 */
export function looksSecret(value: string): boolean {
  return PATTERNS.slice(0, 6).some((re) => new RegExp(re.source, re.flags.replace('g', '')).test(value));
}
