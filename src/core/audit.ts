import fs from 'node:fs';
import path from 'node:path';
import { git } from './git';
import { chat } from './llm';
import { redactSecrets } from './redact';
import type { RelayConfig } from './types';

export interface AuditResult {
  /** 报告相对 worktree 的路径（.relay/audits/...） */
  reportPath: string;
  /** ok = 事实报告 + 阅读面齐全；failed = 只有事实报告（阅读面失败或未配置）。 */
  status: 'ok' | 'failed';
  /** 阅读面给出的「建议的下一步」，交给 handoff.md 的生成内容节。 */
  modelNext: string | null;
}

const MAX_HUNK_LINES = 200;
const MAX_TOTAL_LINES = 2000;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 截断后的已提交 diff（base..checkpoint，不含 .relay）：二进制只记一行；每文件限行；总量限行。锁文件/生成物靠调用方用 .gitignore 处理。 */
function truncatedDiff(worktree: string, base: string, checkpoint: string): string {
  const rawResult = git(worktree, ['diff', `${base}..${checkpoint}`, '--', '.', ':(exclude).relay']);
  if (rawResult.code !== 0) return `（读取失败：${rawResult.stderr || rawResult.code}）`;
  const raw = rawResult.stdout;
  if (raw === '') return '';
  const parts = raw.split(/(?=^diff --git )/m).filter((s) => s.trim() !== '');
  const out: string[] = [];
  let total = 0;
  for (const part of parts) {
    if (part.includes('Binary files') || part.includes('GIT binary patch')) {
      out.push(`${part.split('\n')[0]}\n（二进制文件，仅记录存在改动）`);
      continue;
    }
    const lines = part.split('\n');
    const kept = lines.slice(0, MAX_HUNK_LINES);
    if (lines.length > MAX_HUNK_LINES) kept.push(`…（${lines.length - MAX_HUNK_LINES} 行截断）`);
    out.push(kept.join('\n'));
    total += kept.length;
    if (total > MAX_TOTAL_LINES) {
      out.push(`…（总行数超过 ${MAX_TOTAL_LINES}，其余文件截断）`);
      break;
    }
  }
  return out.join('\n');
}

interface ReadingJson {
  what?: unknown;
  why?: unknown;
  risks?: unknown;
  remaining?: unknown;
}

function extractJson(raw: string): ReadingJson {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('模型输出中找不到 JSON 对象');
  return JSON.parse(m[0]) as ReadingJson;
}

/**
 * 两段式审计的阶段 1+2：事实段（git，不可能失败）必落盘；
 * 阅读面（便宜模型）尽力而为，任何失败都不抛出——handoff 不因审计卡住（F6）。
 * 检查点须已先行提交（handoff 先 commitAll 再审计）：所有 diff 比 base..checkpointSha
 * 两份提交，新建文件也有内容；不再依赖工作区未跟踪列表当主证据。
 */
export async function runAudit(
  worktree: string,
  cfg: RelayConfig,
  agent: string,
  base: string,
  checkpointSha: string
): Promise<AuditResult> {
  const rel = `.relay/audits/${stamp()}-${agent}.md`;
  const abs = path.join(worktree, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  // 排除 .relay 自身：会话文件是框架产物，不是 agent 的业务改动
  const range = `${base}..${checkpointSha}`;
  const stat = git(worktree, ['diff', '--stat', range, '--', '.', ':(exclude).relay']);
  const diffstat =
    stat.code === 0 ? stat.stdout || '（无业务改动）' : `（读取失败：${stat.stderr || stat.code}）`;
  const committedDiff = truncatedDiff(worktree, base, checkpointSha);
  const workStatus = git(worktree, ['status', '--porcelain']);
  const porcelain = workStatus.code === 0 ? workStatus.stdout : `（读取失败：${workStatus.stderr || workStatus.code}）`;

  const facts = [
    '# 审计报告（relay）',
    '',
    `- agent：${agent}`,
    `- 基准：\`${base}\``,
    `- 审计范围（已提交）：\`${range}\``,
    `- 时间：${new Date().toISOString()}`,
    '',
    '## 事实段（git 生成，不可能失败；这就是事实）',
    '',
    '### diffstat（相对基准的已提交 diff，不含 .relay）',
    '```',
    diffstat,
    '```',
    '',
    '### 已提交 diff（截断，不含 .relay）',
    '```diff',
    committedDiff || '（无业务改动）',
    '```',
    '',
    porcelain !== '' ? `### 工作区状态\n\`\`\`\n${porcelain}\n\`\`\`` : '### 工作区状态\n干净（业务改动已在检查点入库）',
  ].join('\n') + '\n';
  fs.writeFileSync(abs, facts);

  let status: 'ok' | 'failed' = 'failed';
  let modelNext: string | null = null;
  const key = process.env[cfg.audit.apiKeyEnv] ?? '';
  if (cfg.audit.baseUrl.trim() === '' || key === '') {
    fs.appendFileSync(
      abs,
      `\n## 阅读面（模型生成）\n\n未生成：审计 API 未配置，或环境变量 ${cfg.audit.apiKeyEnv} 未设置。仅事实报告，交接照常。\n`
    );
  } else {
    try {
      const system =
        '你是代码审计员。只依据给出的 git 事实输出严格 JSON（不要 markdown 代码块）：' +
        '{"what": string[], "why": string, "risks": string[], "remaining": string}。' +
        'what=逐文件改动概述；why=意图推断；risks=风险点（没有就空数组）；' +
        'remaining=写给下一位接手 agent 的「建议的下一步」（一两句话，没有则空字符串）。';
      const user = [
        `任务背景见仓库 .relay/task.md。审计范围（已提交）：${range}`,
        '',
        'diffstat：',
        redactSecrets(diffstat),
        '',
        `截断后的已提交 diff：\n${redactSecrets(committedDiff || '（无业务改动）')}`,
      ].join('\n');
      const raw = await chat({
        baseUrl: cfg.audit.baseUrl,
        model: cfg.audit.model,
        apiKey: key,
        system,
        user,
        timeoutMs: 120_000,
      });
      const json = extractJson(raw);
      fs.appendFileSync(
        abs,
        `\n## 阅读面（模型生成，是评论不是事实；事实以上面 git 输出为准）\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`
      );
      status = 'ok';
      if (typeof json.remaining === 'string' && json.remaining.trim() !== '') {
        modelNext = json.remaining.trim();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cause = e instanceof Error && e.cause instanceof Error ? `；原因：${e.cause.message}` : '';
      fs.appendFileSync(
        abs,
        `\n## 阅读面（模型生成）\n\n生成失败：${msg}${cause}\n仅事实报告，交接照常。\n`
      );
    }
  }
  return { reportPath: rel, status, modelNext };
}
