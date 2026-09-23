/**
 * 送去外部模型之前抹掉密钥。落盘的事实段仍是 git 原文（只在本机）；
 * 只有出网的材料（审计阅读面、讨论）才换成 [REDACTED]。
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
