import fs from 'node:fs';
import path from 'node:path';
import { BRIEF_REL, HANDOFF_DIR, TASK_REL } from './notes';

/**
 * 接力规矩：写进项目的 AGENTS.md（Codex、Cursor、ZCode、MiMo、OpenCode……开工都会读）
 * 和 CLAUDE.md（Claude Code 读）。只动带标记的那一段，你自己写的内容原样不动。
 */

export const BLOCK_START = '<!-- 接力台：开始（这一段由接力台维护，改了会被覆盖；这段以外随便写） -->';
export const BLOCK_END = '<!-- 接力台：结束 -->';

export const PROTOCOL_FILES = ['AGENTS.md', 'CLAUDE.md'];

export function protocolBlock(): string {
  return [
    BLOCK_START,
    '## 接力规矩',
    '',
    '这个项目由好几个 AI 轮流接着做（谁的额度用完了就换下一个），「接力台」在旁边记账。你是其中一棒，请照做：',
    '',
    `1. **开工先读 \`${BRIEF_REL}\`**：任务、进度、上一棒留的话、待复核的改动、这一棒要做什么，都在里面。`,
    '2. **先复核**：接力本里有「待复核」、而你是接力本里列出的强模型时，先按里面的步骤复核，再干新活。',
    `3. **开工就建交接文件**：在 \`${HANDOFF_DIR}/\` 新建一个文件（文件名和格式见接力本），开头写清楚你是谁：工具 + 你实际用的模型（比如「Claude Code · claude-opus-5-5」「Claude Code · deepseek-flash」，不要只写 Claude；接力台会对照工具自己的记录）。边做边记，额度随时可能用完，没记下的等于没做。`,
    `4. **进度写进 \`${TASK_REL}\`**：做完一步就打勾；用户直接交给你的新要求，也先写进去再做。`,
    '5. **收工前把交接写完整**：做了什么、没做完的、不确定的地方、怎么验证；状态改成「已交接」（整个任务都做完了写「全部完成」）。',
    '6. 不要改 `.relay/` 里别的文件（接力本由接力台生成，账本和快照不能碰）。',
    BLOCK_END,
  ].join('\n');
}

const BLOCK_RE = new RegExp(`${escape(BLOCK_START.slice(0, 12))}[\\s\\S]*?${escape(BLOCK_END)}\\n?`);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把规矩写进（或更新）一个文件；返回是否改了。 */
export function upsertBlock(file: string, block = protocolBlock()): boolean {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let next: string;
  if (BLOCK_RE.test(cur)) next = cur.replace(BLOCK_RE, `${block}\n`);
  else if (!cur.trim()) next = `${block}\n`;
  else next = `${cur}${cur.endsWith('\n') ? '' : '\n'}\n${block}\n`;
  if (next === cur) return false;
  fs.writeFileSync(file, next);
  return true;
}

/** 从一个文件里去掉规矩；文件只剩规矩的话整个删掉。返回是否改了。 */
export function removeBlock(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const cur = fs.readFileSync(file, 'utf8');
  if (!BLOCK_RE.test(cur)) return false;
  const next = cur.replace(BLOCK_RE, '').replace(/\n{3,}$/, '\n\n').trimEnd();
  if (!next.trim()) fs.rmSync(file);
  else fs.writeFileSync(file, `${next}\n`);
  return true;
}

export function hasBlock(file: string): boolean {
  try {
    return BLOCK_RE.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** CLAUDE.md 已经用 @AGENTS.md 引用了 AGENTS.md 时，不用再写一遍。 */
function claudeImportsAgents(root: string): boolean {
  try {
    return /^\s*@\.?\/?AGENTS\.md\s*$/m.test(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'));
  } catch {
    return false;
  }
}

/** 写进 AGENTS.md 和 CLAUDE.md；返回改了哪些文件。 */
export function installProtocol(root: string): string[] {
  const changed: string[] = [];
  for (const f of PROTOCOL_FILES) {
    if (f === 'CLAUDE.md' && claudeImportsAgents(root)) continue;
    if (upsertBlock(path.join(root, f))) changed.push(f);
  }
  return changed;
}

export function removeProtocol(root: string): string[] {
  return PROTOCOL_FILES.filter((f) => removeBlock(path.join(root, f)));
}

/** 规矩还在不在、是不是最新的。 */
export function protocolState(root: string): 'ok' | 'old' | 'missing' {
  const want = protocolBlock();
  let any = false;
  let stale = false;
  for (const f of PROTOCOL_FILES) {
    if (f === 'CLAUDE.md' && claudeImportsAgents(root)) continue;
    const p = path.join(root, f);
    if (!hasBlock(p)) {
      stale = true;
      continue;
    }
    any = true;
    const m = fs.readFileSync(p, 'utf8').match(BLOCK_RE);
    if (!m || m[0].trim() !== want.trim()) stale = true;
  }
  if (!any) return 'missing';
  return stale ? 'old' : 'ok';
}
