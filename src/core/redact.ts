/**
 * 送给便宜模型之前的脱敏。落盘事实段仍是 git 原文（本地可审）；
 * 只把出网的阅读面材料换成 [REDACTED]，避免 .env / token 被送走。
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(api[_-]?key|secret|token|access[_-]?token)\s*[:=]\s*['"]?[^\s'"]{12,}['"]?/gi,
  /"(?:api[_-]?key|apiKey|secret|token|access[_-]?token)"\s*:\s*"[^"]+"/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}
