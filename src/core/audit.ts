import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from './errors';
import { git } from './git';
import { loadDetected } from './detect';
import { apiUsable, chat } from './llm';
import { redactSecrets } from './redact';
import type { ApiSpec, RelayConfig } from './types';

export interface AuditResult {
  /** 报告在工作副本里的相对路径（.relay/audits/...）。 */
  reportPath: string;
  /** ok = 事实 + 模型阅读面；failed = 只有事实。 */
  status: 'ok' | 'failed';
  /** 模型给下一位的建议（写进交接文档「建议的下一步」）。 */
  modelNext: string | null;
  /** 没有阅读面的原因（没配 / 没密钥 / 调用失败 / 本段没改动）。 */
  modelNote: string | null;
}

const MAX_FILE_LINES = 200;
const MAX_TOTAL_LINES = 2000;

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** base..checkpoint 的业务 diff（不含 .relay），二进制只记一行，每个文件、总量都限行。 */
export function truncatedDiff(worktree: string, base: string, checkpoint: string): string {
  const r = git(worktree, ['diff', '--find-renames', `${base}..${checkpoint}`, '--', '.', ':(exclude).relay'], { raw: true });
  if (r.code !== 0) return `（读取失败：${r.stderr || r.code}）`;
  const raw = r.stdout.trimEnd();
  if (raw === '') return '';
  const parts = raw.split(/(?=^diff --git )/m).filter((s) => s.trim() !== '');
  const out: string[] = [];
  let total = 0;
  for (const part of parts) {
    if (/^Binary files |^GIT binary patch/m.test(part)) {
      out.push(`${part.split('\n')[0]}\n（二进制文件，只记录有改动）`);
      continue;
    }
    const lines = part.split('\n');
    const kept = lines.slice(0, MAX_FILE_LINES);
    if (lines.length > MAX_FILE_LINES) kept.push(`…（这个文件还有 ${lines.length - MAX_FILE_LINES} 行没列出）`);
    out.push(kept.join('\n'));
    total += kept.length;
    if (total > MAX_TOTAL_LINES) {
      out.push(`…（总共超过 ${MAX_TOTAL_LINES} 行，其余文件没列出）`);
      break;
    }
  }
  return out.join('\n');
}

interface Reading {
  what?: unknown;
  why?: unknown;
  risks?: unknown;
  remaining?: unknown;
}

function extractJson(raw: string): Reading {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型的回答里找不到 JSON');
  return JSON.parse(m[0]) as Reading;
}

function listOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.trim());
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

export function renderReading(r: Reading): string {
  const what = listOf(r.what);
  const risks = listOf(r.risks);
  const lines: string[] = [];
  if (what.length) lines.push('**改了什么**', ...what.map((w) => `- ${w}`), '');
  if (typeof r.why === 'string' && r.why.trim()) lines.push('**意图**', r.why.trim(), '');
  lines.push('**风险**', ...(risks.length ? risks.map((w) => `- ${w}`) : ['- 没看出明显风险']), '');
  if (typeof r.remaining === 'string' && r.remaining.trim()) lines.push('**建议的下一步**', r.remaining.trim(), '');
  return lines.join('\n').trim();
}

/**
 * 审计用的模型：配置里写的模型在接口上已经没有了（模型会改名下架，比如 deepseek-chat），
 * 就按上次自动识别列出的模型换一个便宜的，交接照常有阅读面。
 */
export function auditSpec(api: ApiSpec): { spec: ApiSpec; note?: string } {
  const base = api.baseUrl.replace(/\/+$/, '');
  const p = loadDetected()?.providers.find((x) => x.state === 'ok' && x.baseUrl.replace(/\/+$/, '') === base);
  if (!p || !p.models.length || p.models.includes(api.model)) return { spec: api };
  const m = p.models.find((x) => /flash|mini|lite|haiku|small|turbo/i.test(x)) ?? p.model ?? p.models[0];
  return { spec: { ...api, model: m }, note: `配置里的模型 ${api.model} 接口上已经没有了，改用 ${m}` };
}

export interface AuditInput {
  worktree: string;
  cfg: RelayConfig;
  agent: string;
  agentLabel: string;
  base: string;
  checkpoint: string;
  taskTitle: string;
  /** 上一位的自述（给模型参考，也照录进报告）。 */
  selfNote?: string;
  /** 本段没有业务改动：不调模型。 */
  empty?: boolean;
}

/**
 * 两段式审计：事实段（git 生成，一定有）先落盘；阅读面（便宜模型）尽力而为，
 * 任何失败都只记一句原因，不影响交接。检查点必须已经提交：一律比较 base..checkpoint 两个提交。
 */
export async function runAudit(input: AuditInput): Promise<AuditResult> {
  const { worktree, cfg, base, checkpoint } = input;
  const dir = path.join(worktree, '.relay', 'audits');
  fs.mkdirSync(dir, { recursive: true });
  let name = `${stamp()}-${input.agent}.md`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${stamp()}-${input.agent}-${i}.md`;
  const rel = `.relay/audits/${name}`;
  const abs = path.join(worktree, rel);

  const range = `${base}..${checkpoint}`;
  const stat = git(worktree, ['diff', '--stat', '--find-renames', range, '--', '.', ':(exclude).relay']);
  const diffstat = stat.code === 0 ? stat.stdout || '（没有业务改动）' : `（读取失败：${stat.stderr || stat.code}）`;
  const diff = truncatedDiff(worktree, base, checkpoint);

  const facts = [
    `# 审计报告：${input.agentLabel} 这一段`,
    '',
    `- 任务：${input.taskTitle}`,
    `- 范围：\`${base.slice(0, 9)}..${checkpoint.slice(0, 9)}\`（已提交的业务改动，不含 .relay）`,
    `- 时间：${new Date().toISOString()}`,
    '',
    '## 事实（git 生成，以这里为准）',
    '',
    '### 改动统计',
    '```',
    diffstat,
    '```',
    '',
    '### 改动内容（过长会截断）',
    '```diff',
    diff || '（没有业务改动）',
    '```',
    '',
  ];
  if (input.selfNote?.trim()) {
    facts.push('## 上一位的自述（它自己写的，不是事实）', '', input.selfNote.trim(), '');
  }
  fs.writeFileSync(abs, facts.join('\n'));

  const done = (status: 'ok' | 'failed', modelNext: string | null, modelNote: string | null): AuditResult => ({
    reportPath: rel,
    status,
    modelNext,
    modelNote,
  });

  const append = (title: string, body: string) => fs.appendFileSync(abs, `## ${title}\n\n${body.trim()}\n`);

  if (input.empty) {
    append('阅读面（模型生成）', '这一段没有业务改动，没有请模型看。');
    return done('failed', null, '这一段没有业务改动');
  }
  const api = cfg.audit;
  if (!api.baseUrl.trim() || !api.model.trim() || !api.apiKeyEnv.trim()) {
    append('阅读面（模型生成）', '没有配置审计模型。只有上面的事实，交接照常。');
    return done('failed', null, '没有配置审计模型');
  }
  if (!apiUsable(api)) {
    append('阅读面（模型生成）', `没有设置环境变量 ${api.apiKeyEnv}（放密钥的地方）。只有上面的事实，交接照常。`);
    return done('failed', null, `没有设置 ${api.apiKeyEnv}`);
  }
  try {
    const system =
      '你是代码审计员。只根据给出的 git 事实判断，输出严格 JSON（不要代码块）：' +
      '{"what": string[], "why": string, "risks": string[], "remaining": string}。' +
      'what = 逐个文件说改了什么；why = 推测的意图；risks = 风险点（没有就空数组）；' +
      'remaining = 给下一位接手者的一两句建议（祈使句；没有就空字符串）。用中文。';
    const user = [
      `任务：${redactSecrets(input.taskTitle)}`,
      `范围：${range}`,
      input.selfNote?.trim() ? `上一位的自述（不一定可信）：\n${redactSecrets(input.selfNote.trim())}` : '',
      `改动统计：\n${redactSecrets(diffstat)}`,
      `改动内容：\n${redactSecrets(diff || '（没有业务改动）')}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const picked = auditSpec(api);
    if (picked.note) fs.appendFileSync(abs, `> ${picked.note}。\n\n`);
    const raw = await chat(picked.spec, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { timeoutMs: 120_000, temperature: 0.2 });
    const reading = extractJson(raw);
    append('阅读面（模型生成，是评论不是事实）', renderReading(reading));
    const next = typeof reading.remaining === 'string' && reading.remaining.trim() ? reading.remaining.trim() : null;
    return done('ok', next, null);
  } catch (e) {
    const why = errorMessage(e);
    append('阅读面（模型生成）', `这次没生成：${why}\n只有上面的事实，交接照常。`);
    return done('failed', null, why);
  }
}
